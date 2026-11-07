// Controlled HTTP fixtures only; never contacts Spotify or a model service.
import type {
	CalibrationLabelResult,
	CalibrationLabelRequest,
	ModelMetrics,
} from "@sortfm/contracts";
import { createLiveApi } from "../data/live-client";
import { liveFixture, coldModelMetrics } from "./live-fixture";
export function calibrationFixture() {
	const base = liveFixture();
	const source = structuredClone(base.items);
	const history: CalibrationLabelResult[] = [];
	const calls: { url: string; init?: RequestInit }[] = [];
	let revision = 0;
	let responseLost = false;
	let queueFails = false;
	let historyFails = false;
	let unavailable = false;
	let fitFails = false;
	let metrics: ModelMetrics = { ...coldModelMetrics };
	const commands = new Map<string, CalibrationLabelResult>();
	const transport = (async (input, init) => {
		const url = String(input);
		calls.push({ url, init });
		const fail = (code = "OFFLINE", status = 503) =>
			Response.json(
				{
					code,
					message: "Controlled service unavailable",
					retryable: status === 503,
				},
				{ status },
			);
		if (url.endsWith("/api/me")) return Response.json(base.session);
		if (unavailable && url.includes("/api/calibration/"))
			return fail("NOT_IMPLEMENTED", 501);
		if (url.includes("/api/calibration/queue?")) {
			if (queueFails) return fail();
			const items = source
				.filter(
					(item) =>
						!history.some(
							(h) => h.trackId === item.track.trackId && h.state === "active",
						),
				)
				.map((item) => ({
					...item,
					exposure: {
						...item.exposure,
						exposureId: crypto.randomUUID(),
						policyVersion: "calibration-metadata-v1",
					},
				}));
			return Response.json({
				contractVersion: "1.0.0",
				mode: "calibration",
				items,
				remaining: items.length,
				nextCursor: null,
				fallbackReason: null,
			});
		}
		if (url.endsWith("/api/calibration/history"))
			return historyFails
				? fail()
				: Response.json({ items: history, nextCursor: null });
		if (url.endsWith("/api/calibration/labels")) {
			const req = JSON.parse(String(init?.body)) as CalibrationLabelRequest;
			let result = commands.get(req.idempotencyKey);
			if (!result) {
				const now = new Date().toISOString();
				result = {
					...req,
					mode: "calibration",
					labelId: crypto.randomUUID(),
					submittedLabel: req.label,
					state: "active",
					canUndo: true,
					feedbackRevision: ++revision,
					createdAt: now,
					updatedAt: now,
				};
				history.unshift(result);
				commands.set(req.idempotencyKey, result);
			}
			if (responseLost) {
				responseLost = false;
				throw new TypeError("Response lost after commit");
			}
			return Response.json(result);
		}
		if (/\/api\/calibration\/labels\/[^/]+\/undo$/.test(url)) {
			const result = history.find((h) => h.labelId === url.split("/").at(-2));
			if (!result) return fail("NOT_FOUND", 404);
			if (result.state === "active")
				Object.assign(result, {
					state: "revoked",
					label: null,
					canUndo: false,
					feedbackRevision: ++revision,
				});
			if (responseLost) {
				responseLost = false;
				throw new TypeError("Undo response lost after commit");
			}
			return Response.json(result);
		}
		if (url.endsWith("/api/ml/insights"))
			return Response.json({
				metrics,
				prediction: null,
				audioFeatures: {
					provider: "soundnet",
					status: "disabled",
					featuresReady: 0,
					featuresTotal: 2,
					failed: 0,
					missingness: {},
					reason: "Controlled fixture",
				},
			});
		if (url.endsWith("/api/ml/retrain")) {
			if (fitFails) return fail();
			const count = history.filter((h) => h.state === "active").length;
			metrics = {
				...coldModelMetrics,
				modelVersion: `fit-${revision}`,
				dataset: count ? "user_feedback" : "synthetic",
				labeledExamples: count,
			};
			return Response.json({
				userId: base.session.user!.id,
				modelVersion: metrics.modelVersion,
				featureVersion: "sortfm.features.v1",
				feedbackRevision: revision,
				trainedExamples: 0,
				metrics,
			});
		}
		throw new Error(`Forbidden route in calibration: ${url}`);
	}) as typeof fetch;
	const data = new Map<string, string>();
	const storage = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, value);
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
	};
	return {
		session: base.session,
		api: createLiveApi({ fetch: transport }),
		transport,
		storage,
		calls,
		history,
		source,
		loseResponse: () => {
			responseLost = true;
		},
		failQueue: (value: boolean) => {
			queueFails = value;
		},
		failHistory: (value: boolean) => {
			historyFails = value;
		},
		unavailable: (value: boolean) => {
			unavailable = value;
		},
		failFit: (value: boolean) => {
			fitFails = value;
		},
		setMetrics: (value: ModelMetrics) => {
			metrics = value;
		},
	};
}
