// Simulated HTTP data for tests only. No Spotify service is contacted.
import { demoBootstrap } from "@sortfm/contracts/fixtures";
import {
	type AccountSession,
	type ReviewRequest,
	type ReviewResult,
	labelForAction,
} from "@sortfm/contracts";
import {
	createLiveApi,
	createLiveClient,
	pendingJournal,
} from "../data/live-client";

export function liveFixture() {
	const session: AccountSession = {
		mode: "spotify",
		user: {
			id: "owner",
			spotifyId: "owner",
			displayName: "Listener",
			avatarUrl: null,
		},
		capabilities: { spotifyRead: true, spotifyWrite: true, playback: false },
	};
	const items = demoBootstrap.queue.items.slice(0, 2).map((item, i) => ({
		...structuredClone(item),
		exposure: { ...item.exposure, trackId: `${i}`.repeat(22) },
		track: {
			...item.track,
			trackId: `${i}`.repeat(22),
			source: "spotify" as const,
			isPlayable: true,
			spotifyUri:
				`spotify:track:${`${i}`.repeat(22)}` as `spotify:track:${string}`,
		},
	}));
	const allItems = structuredClone(items);
	const summary = {
		total: 2700,
		reviewed: 4200,
		remaining: 2,
		kept: 4,
		archived: 2,
		unliked: 1,
		skipped: 1,
	};
	const history: ReviewResult[] = [];
	const commands: ReviewRequest[] = [];
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	let queueError = false,
		decisionError = false;
	const transport = (async (input, init) => {
		const url = String(input);
		calls.push({ url, init });
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url.endsWith("/api/me")) return json(session);
		if (url.includes("/api/queue?"))
			return queueError
				? json(
						{ code: "OFFLINE", message: "Queue unavailable", retryable: false },
						503,
					)
				: json({
						...demoBootstrap.queue,
						mode: "spotify",
						items,
						remaining: summary.remaining,
						nextCursor: null,
					});
		if (url.endsWith("/api/library/summary")) return json(summary);
		if (url.endsWith("/api/decisions/history"))
			return json({ items: history, nextCursor: null });
		if (url.endsWith("/api/ml/insights"))
			return json({
				prediction: null,
				metrics: {
					...demoBootstrap.metrics,
					dataset: "user_feedback",
					reason: "Controlled HTTP fixture; no live training.",
				},
				audioFeatures: {
					provider: "soundnet",
					status: "disabled",
					featuresReady: 0,
					featuresTotal: 2,
					failed: 0,
					missingness: {},
					reason: "Not connected",
				},
			});
		if (url.endsWith("/api/decisions")) {
			const request = JSON.parse(String(init?.body)) as ReviewRequest;
			commands.push(request);
			if (decisionError)
				return json(
					{ code: "UNAVAILABLE", message: "Try again", retryable: true },
					503,
				);
			const previous = history.find(
				(h) => h.idempotencyKey === request.idempotencyKey,
			);
			if (previous) return json(previous);
			const result: ReviewResult = {
				...request,
				decisionId: crypto.randomUUID(),
				mode: "spotify",
				status: "COMPLETE",
				mutationStep: ["ARCHIVE", "UNLIKE"].includes(request.action)
					? "UNLIKED"
					: "NONE",
				liked: !["ARCHIVE", "UNLIKE"].includes(request.action),
				archived: request.action === "ARCHIVE",
				canUndo: true,
				label: labelForAction(request.action),
				labelState: request.action === "SKIP" ? "inactive" : "active",
				feedbackRevision: 1,
				error: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			history.unshift(result);
			items.splice(
				items.findIndex((i) => i.track.trackId === request.trackId),
				1,
			);
			summary.remaining--;
			return json(result);
		}
		if (url.endsWith("/undo")) {
			const id = url.split("/").at(-2);
			const original = history.find((h) => h.decisionId === id)!;
			if (original.status !== "UNDONE") {
				const restored = allItems.find(
					(item) => item.track.trackId === original.trackId,
				)!;
				items.unshift({
					...structuredClone(restored),
					exposure: {
						...restored.exposure,
						exposureId: crypto.randomUUID(),
						servedAt: new Date().toISOString(),
					},
				});
				summary.remaining++;
			}
			Object.assign(original, {
				status: "UNDONE",
				mutationStep: ["ARCHIVE", "UNLIKE"].includes(original.action)
					? "RESTORED"
					: "NONE",
				liked: true,
				label: null,
				labelState: "revoked",
				canUndo: false,
				feedbackRevision: 2,
			});
			return json(original);
		}
		return json(
			{ code: "NOT_IMPLEMENTED", message: "Unavailable", retryable: false },
			501,
		);
	}) as typeof fetch;
	const data = new Map<string, string>();
	const storage = {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			data.set(k, v);
		},
		removeItem: (k: string) => {
			data.delete(k);
		},
	};
	const api = createLiveApi({ fetch: transport });
	const journal = pendingJournal(storage, "owner");
	const client = createLiveClient(api, session, journal);
	return {
		transport,
		api,
		client,
		journal,
		storage,
		session,
		items,
		summary,
		history,
		commands,
		calls,
		setQueueError: (v: boolean) => {
			queueError = v;
		},
		setDecisionError: (v: boolean) => {
			decisionError = v;
		},
	};
}
