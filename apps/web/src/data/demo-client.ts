import {
	DemoBootstrapSchema,
	ReviewRequestSchema,
	ReviewResultSchema,
	UndoRequestSchema,
	labelForAction,
	type ReviewResult,
} from "@sortfm/contracts";
import { createDemoQueue, demoBootstrap } from "@sortfm/contracts/fixtures";
import type { createApiClient } from "@sortfm/contracts/client";

/** B2 seam: method signatures are identical to the shared, validated HTTP client. */
import type { LiveGateway } from "./live-client";
import { shuffledDemoTracks } from "./demo-catalog";

export type ReviewClient = Pick<
	ReturnType<typeof createApiClient>,
	"demoBootstrap" | "queue" | "decide" | "undo" | "history" | "insights"
> & { live?: LiveGateway };
export type DemoScenario = "empty" | "load-error" | "decision-error";
export function createDemoClient({
	latency = 420,
	scenario,
}: {
	latency?: number;
	scenario?: DemoScenario;
} = {}): ReviewClient {
	const template = createDemoQueue({ limit: 1 }).items[0]!;
	const tracks = shuffledDemoTracks();
	const queue = {
		...createDemoQueue({ limit: 0 }),
		remaining: tracks.length,
		fallbackReason: "Shuffled demo collection. Saved dates and review decisions are simulated.",
		items: tracks.map((track, position) => ({
			...template,
			track,
			exposure: { ...template.exposure, trackId: track.trackId, exposureId: crypto.randomUUID(), position },
		})),
	};
	const decisions = new Map<string, ReviewResult>();
	const archiveCopies = new Set<string>();
	const commands = new Map<
		string,
		{ fingerprint: string; result: ReviewResult }
	>();
	let failLoad = scenario === "load-error";
	let failDecision = scenario === "decision-error";
	let revision = 0;
	const pause = () =>
		new Promise<void>((resolve) => setTimeout(resolve, latency));
	const getQueue = () => ({
		...queue,
		items: scenario === "empty" ? [] : queue.items,
		remaining: scenario === "empty" ? 0 : queue.remaining,
	});
	return {
		async demoBootstrap() {
			await pause();
			if (failLoad) {
				failLoad = false;
				throw new Error(
					"The demo library couldn't be loaded. Please try again.",
				);
			}
			return DemoBootstrapSchema.parse({
				...demoBootstrap,
				queue: getQueue(),
				notice:
					"Real songs, streamed previews. Saved dates are simulated; decisions stay in this tab. Nothing changes on Spotify.",
			});
		},
		async queue() {
			await pause();
			return getQueue();
		},
		async decide(input) {
			const request = ReviewRequestSchema.parse(input);
			await pause();
			if (failDecision) {
				failDecision = false;
				throw new Error(
					"That decision didn't go through. Your song is still here.",
				);
			}
			const fingerprint = JSON.stringify(request);
			const previous = commands.get(request.idempotencyKey);
			if (previous) {
				if (previous.fingerprint !== fingerprint)
					throw new Error(
						"This command key has already been used for another decision.",
					);
				return previous.result;
			}
			if (
				!queue.items.some(
					(item) =>
						item.track.trackId === request.trackId &&
						item.exposure.exposureId === request.exposureId,
				)
			)
				throw new Error("This track is not in the demo queue.");
			const destructive =
				request.action === "ARCHIVE" || request.action === "UNLIKE";
			const now = new Date().toISOString();
			if (request.action === "ARCHIVE") archiveCopies.add(request.trackId);
			const result = ReviewResultSchema.parse({
				...request,
				decisionId: crypto.randomUUID(),
				status: "COMPLETE",
				mutationStep: destructive ? "UNLIKED" : "NONE",
				mode: "demo",
				liked: !destructive,
				archived: archiveCopies.has(request.trackId),
				canUndo: true,
				label: labelForAction(request.action),
				labelState: request.action === "SKIP" ? "inactive" : "active",
				feedbackRevision: ++revision,
				error: null,
				createdAt: now,
				updatedAt: now,
			});
			decisions.set(result.decisionId, result);
			commands.set(request.idempotencyKey, { fingerprint, result });
			return result;
		},
		async undo(decisionId, input) {
			const request = UndoRequestSchema.parse(input);
			await pause();
			const fingerprint = `undo:${decisionId}`;
			const previous = commands.get(request.idempotencyKey);
			if (previous) {
				if (previous.fingerprint !== fingerprint)
					throw new Error("This undo key has already been used.");
				return previous.result;
			}
			const original = decisions.get(decisionId);
			if (!original?.canUndo)
				throw new Error("This decision has already been restored.");
			const result = ReviewResultSchema.parse({
				...original,
				status: "UNDONE",
				mutationStep: ["ARCHIVE", "UNLIKE"].includes(original.action)
					? "RESTORED"
					: "NONE",
				liked: true,
				canUndo: false,
				label: null,
				labelState: "revoked",
				feedbackRevision: ++revision,
				updatedAt: new Date().toISOString(),
			});
			decisions.set(decisionId, result);
			commands.set(request.idempotencyKey, { fingerprint, result });
			return result;
		},
		async history() {
			return { items: [...decisions.values()].reverse(), nextCursor: null };
		},
		async insights() {
			return {
				prediction: null,
				metrics: demoBootstrap.metrics,
				audioFeatures: {
					provider: "soundnet",
					status: "disabled",
					featuresReady: 0,
					featuresTotal: queue.remaining,
					failed: 0,
					missingness: {},
					reason: "SoundNet is not connected in demo mode.",
				},
			};
		},
	};
}
