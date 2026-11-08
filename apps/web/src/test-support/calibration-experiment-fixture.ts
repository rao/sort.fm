// Synthetic HTTP fixture; never contacts Spotify, a model, or a database.
import {
	CalibrationExperimentSchema,
	CalibrationExperimentReadySchema,
	type CalibrationExperiment,
	type CalibrationExperimentReady,
	type CalibrationExperimentSkip,
} from "@sortfm/contracts";
import { createLiveApi } from "../data/live-client";
import { calibrationFixture } from "./calibration-fixture";

export function calibrationExperimentFixture() {
	const f = calibrationFixture();
	const at = "2026-11-08T12:00:00.000Z";
	const readyAt = "2026-11-08T12:01:00.000Z";
	const batchId = crypto.randomUUID();
	const modelVersion = "test:batch3-frozen";
	const items = Array.from({ length: 60 }, (_, i) => {
		const base = structuredClone(f.source[0]!);
		const trackId = String(100 + i).padStart(22, "0");
		return {
			...base,
			track: {
				...base.track,
				trackId,
				title: `Private batch song ${i}`,
				spotifyUri: `spotify:track:${trackId}` as const,
			},
			prediction: { ...base.prediction, modelVersion },
			exposure: {
				...base.exposure,
				trackId,
				modelVersion,
				exposureId: crypto.randomUUID(),
			},
		};
	});
	const ready: CalibrationExperimentReady =
		CalibrationExperimentReadySchema.parse({
			batchId,
			experiment: "calibration-batch3-v1",
			phase: "ready",
			reservedAt: at,
			readyAt,
			algorithmVersion: "fixture",
			modelVersion,
			candidateCount: 100,
			target: 60,
			labeled: 0,
			trainingLabeled: 0,
			sealedLabeled: 0,
			groups: ["A", "B", "C"].map((group) => ({
				group,
				target: group === "A" ? 40 : group === "B" ? 20 : 0,
				pending: group === "A" ? 40 : group === "B" ? 20 : 0,
				labeled: 0,
				skipped: 0,
				revoked: 0,
			})),
			entries: items.map((item, i) => ({
				batchItemId: crypto.randomUUID(),
				exposureId: item.exposure.exposureId,
				trackId: item.track.trackId,
				group: i < 40 ? "A" : "B",
				assignment: i < 40 ? "sealed_evaluation" : "train",
				samplingMethod: "fixture",
				selectionScore: i < 40 ? null : 0.5,
				selectionProbability: i < 40 ? 0.4 : null,
				scoreKind: i < 40 ? "seeded_random" : "coverage_distance",
				selectedAt: at,
				status: "pending",
				replacementFor: null,
			})),
			queue: {
				contractVersion: "1.0.0",
				mode: "calibration",
				items,
				remaining: 60,
				nextCursor: null,
				fallbackReason: null,
			},
		});
	const reserved = CalibrationExperimentSchema.parse({
		batchId,
		experiment: "calibration-batch3-v1",
		phase: "reserved",
		reservedAt: at,
		target: 60,
		groups: ["A", "B", "C"].map((group) => ({
			group,
			target: group === "A" ? 40 : group === "B" ? 20 : 0,
			reserved: group === "A" ? 40 : group === "B" ? 20 : 0,
		})),
	});
	let phase: "absent" | "reserved" | "ready" = "reserved";
	let lostSkip = false;
	let fails = false;
	const skips = new Map<string, string>();
	const calls: { url: string; init?: RequestInit }[] = [];
	function snapshot(): CalibrationExperiment | null {
		if (phase === "absent") return null;
		if (phase === "reserved") return structuredClone(reserved);
		for (const entry of ready.entries) {
			if (entry.status === "skipped") continue;
			const label = f.history.find((h) => h.trackId === entry.trackId);
			if (label)
				entry.status = label.state === "active" ? "labeled" : "revoked";
		}
		for (const group of ready.groups) {
			const entries = ready.entries.filter((e) => e.group === group.group);
			group.labeled = entries.filter((e) => e.status === "labeled").length;
			group.pending = entries.filter((e) =>
				["pending", "revoked"].includes(e.status),
			).length;
			group.skipped = entries.filter((e) => e.status === "skipped").length;
			group.revoked = entries.filter((e) => e.status === "revoked").length;
		}
		ready.sealedLabeled = ready.groups[0]!.labeled;
		ready.trainingLabeled = ready.groups[1]!.labeled;
		ready.labeled = ready.sealedLabeled + ready.trainingLabeled;
		const result = structuredClone(ready);
		result.queue.items = result.queue.items.filter((i) =>
			result.entries.some(
				(e) =>
					e.exposureId === i.exposure.exposureId &&
					["pending", "revoked"].includes(e.status),
			),
		);
		result.queue.remaining = result.groups.reduce((n, g) => n + g.pending, 0);
		return CalibrationExperimentReadySchema.parse(result);
	}
	const transport = (async (input, init) => {
		const url = String(input);
		calls.push({ url, init });
		if (url.endsWith("/experiments/calibration-batch3-v1")) {
			if (fails)
				return Response.json(
					{ code: "UNAVAILABLE", message: "Try again", retryable: true },
					{ status: 503 },
				);
			return Response.json({ batch: snapshot() });
		}
		if (url.endsWith("/experiments/calibration-batch3-v1/skip")) {
			if (phase !== "ready") throw new Error("Fixture forbids preseal writes");
			const request = JSON.parse(
				String(init?.body),
			) as CalibrationExperimentSkip;
			const entry = ready.entries.find(
				(e) => e.exposureId === request.exposureId,
			)!;
			if (!skips.has(request.idempotencyKey)) {
				entry.status = "skipped";
				skips.set(request.idempotencyKey, request.exposureId);
				if (entry.group === "B") {
					const item = structuredClone(ready.queue.items[0]!);
					const trackId = String(200 + skips.size).padStart(22, "0");
					item.track.trackId = trackId;
					item.track.spotifyUri = `spotify:track:${trackId}`;
					item.exposure.trackId = trackId;
					item.exposure.exposureId = crypto.randomUUID();
					ready.queue.items.push(item);
					ready.entries.push({
						...entry,
						status: "pending",
						selectedAt: readyAt,
						trackId,
						exposureId: item.exposure.exposureId,
						batchItemId: crypto.randomUUID(),
						replacementFor: entry.batchItemId,
					});
				}
			}
			if (lostSkip) {
				lostSkip = false;
				throw new Error("Skip response lost");
			}
			return Response.json(snapshot());
		}
		return f.transport(input, init);
	}) as typeof fetch;
	return {
		...f,
		calls,
		transport,
		api: createLiveApi({ fetch: transport }),
		snapshot,
		ready,
		setPhase: (value: typeof phase) => {
			phase = value;
		},
		failRead: (value: boolean) => {
			fails = value;
		},
		loseSkip: () => {
			lostSkip = true;
		},
		skipCount: () => skips.size,
	};
}
