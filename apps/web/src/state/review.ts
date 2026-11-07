import {
	ACTION_SEMANTICS,
	ReviewResultSchema,
	type DemoBootstrap,
	type ModelMetrics,
	type QueueResult,
	type ReviewAction,
	type ReviewResult,
} from "@sortfm/contracts";
import { ApiError, createIdempotencyKey } from "@sortfm/contracts/client";
import type { ReviewClient } from "../data/demo-client";
import {
	errorMessage,
	isUnauthorized,
	type LiveSnapshot,
	type LibrarySummary,
	type InsightsData,
	type PendingCommand,
} from "../data/live-client";
export type QueueItem = QueueResult["items"][number];
export type HistoryEntry = { item: QueueItem | null; result: ReviewResult };
class TerminalReviewError extends Error {}
type RetryCommand = PendingCommand;
function settles(command: RetryCommand, result: ReviewResult) {
	if (command.kind === "undo")
		return (
			result.decisionId === command.decisionId && result.status === "UNDONE"
		);
	return (
		["COMPLETE", "UNDONE"].includes(result.status) &&
		result.idempotencyKey === command.request.idempotencyKey &&
		result.trackId === command.request.trackId &&
		result.action === command.request.action &&
		result.exposureId === command.request.exposureId
	);
}
export type ReviewState = {
	bootstrap:
		| (Omit<DemoBootstrap, "metrics"> & { metrics: ModelMetrics | null })
		| null;
	summary: LibrarySummary | null;
	insights: InsightsData | null;
	remaining: number | null;
	historyHasMore: boolean;
	warnings: string[];
	refreshError: string | null;
	refreshing: boolean;
	queue: QueueItem[];
	history: HistoryEntry[];
	loading: boolean;
	busy: boolean;
	departure: ReviewAction | null;
	error: string | null;
	terminal: boolean;
	retry: RetryCommand | null;
	notice: string;
	noticeUndoId: string | null;
	noticeRevision: number;
};
export const actionLabels: Record<ReviewAction, string> = {
	KEEP: "Keep",
	ARCHIVE: "Archive",
	SKIP: "Skip",
	UNLIKE: "Unlike",
};
export const actionPast: Record<ReviewAction, string> = {
	KEEP: "Kept",
	ARCHIVE: "Archived",
	SKIP: "Skipped",
	UNLIKE: "Unliked",
};
export function actionFromKey(key: string): ReviewAction | null {
	return (
		(Object.keys(ACTION_SEMANTICS) as ReviewAction[]).find(
			(action) => ACTION_SEMANTICS[action].key === key,
		) ?? null
	);
}
export function actionFromDrag(x: number, y: number): ReviewAction | null {
	if (Math.max(Math.abs(x), Math.abs(y)) < 72) return null;
	return Math.abs(x) > Math.abs(y)
		? x > 0
			? "KEEP"
			: "ARCHIVE"
		: y > 0
			? "UNLIKE"
			: "SKIP";
}
export class ReviewStore {
	private state: ReviewState = {
		bootstrap: null,
		summary: null,
		insights: null,
		remaining: null,
		historyHasMore: false,
		warnings: [],
		refreshError: null,
		refreshing: false,
		queue: [],
		history: [],
		loading: false,
		busy: false,
		departure: null,
		error: null,
		terminal: false,
		retry: null,
		notice: "",
		noticeUndoId: null,
		noticeRevision: 0,
	};
	private listeners = new Set<() => void>();
	constructor(
		private client: ReviewClient,
		private settleMs = 0,
	) {}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<ReviewState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	async load() {
		if (this.state.loading || this.state.busy || this.state.bootstrap) return;
		this.update({ loading: true, error: null });
		try {
			if (this.client.live) {
				const pending = this.client.live.journal.read();
				const snapshot = await this.client.live.snapshot();
				const settled =
					pending &&
					snapshot.history?.find((result) => settles(pending, result));
				if (settled) this.client.live.journal.clear();
				this.applySnapshot(snapshot);
				if (pending && !settled)
					this.update({
						retry: pending,
						terminal: !!pending.terminal,
						error: pending.terminal
							? "This saved command requires account recovery. Its outcome has not been treated as success."
							: "An unfinished command was found. Retry with its original key to check the saved outcome.",
					});
			} else {
				const bootstrap = await this.client.demoBootstrap();
				this.update({ bootstrap, queue: bootstrap.queue.items });
			}
		} catch (error) {
			this.update({
				error:
					error instanceof Error
						? error.message
						: "The library couldn't be loaded.",
			});
		} finally {
			this.update({ loading: false });
		}
	}
	private applySnapshot(snapshot: LiveSnapshot) {
		const known = new Map<string, QueueItem>();
		for (const entry of this.state.history)
			if (entry.item) known.set(entry.item.track.trackId, entry.item);
		for (const item of [...this.state.queue, ...snapshot.queue.items])
			known.set(item.track.trackId, item);
		this.update({
			bootstrap: {
				session: snapshot.session,
				queue: snapshot.queue,
				metrics: snapshot.insights?.metrics ?? null,
				notice: "Connected to Spotify. Confirmed changes update your library.",
			},
			queue: snapshot.queue.items,
			summary: snapshot.summary,
			remaining: snapshot.queue.remaining,
			insights: snapshot.insights,
			history:
				snapshot.history === null
					? this.state.history
					: snapshot.history.map((result) => ({
							result,
							item: known.get(result.trackId) ?? null,
						})),
			historyHasMore: snapshot.historyHasMore,
			warnings: snapshot.warnings,
			refreshError: null,
		});
	}
	async refresh() {
		if (
			!this.client.live ||
			!this.state.bootstrap ||
			this.state.loading ||
			this.state.busy ||
			this.state.refreshing ||
			this.state.retry
		)
			return;
		this.update({ refreshing: true });
		try {
			this.applySnapshot(await this.client.live.snapshot());
		} catch (error) {
			this.update({ refreshError: errorMessage(error) });
		} finally {
			this.update({ refreshing: false });
		}
	}

	async recover() {
		if (
			!this.client.live ||
			this.state.busy ||
			this.state.refreshing ||
			!this.state.retry
		)
			return;
		this.update({ refreshing: true });
		try {
			const command = this.state.retry;
			const snapshot = await this.client.live.snapshot();
			const settled = snapshot.history?.find((result) =>
				settles(command, result),
			);
			if (settled) {
				this.client.live.journal.clear();
				this.update({ retry: null, terminal: false, error: null });
			}
			this.applySnapshot(snapshot);
			if (!settled)
				this.update({
					error:
						"The server has not confirmed this command as settled. Reconnect if permissions changed; otherwise keep review paused for recovery.",
				});
		} catch (error) {
			this.update({ error: errorMessage(error) });
		} finally {
			this.update({ refreshing: false });
		}
	}

	async decide(action: ReviewAction) {
		const item = this.state.queue[0];
		if (
			!item ||
			this.state.busy ||
			this.state.retry ||
			this.state.refreshing ||
			this.state.refreshError
		)
			return;
		return this.run({
			kind: "decide",
			request: {
				trackId: item.track.trackId,
				exposureId: item.exposure.exposureId,
				action,
				idempotencyKey: createIdempotencyKey(),
			},
		});
	}
	async undo(decisionId: string) {
		if (
			this.state.busy ||
			this.state.retry ||
			this.state.refreshing ||
			this.state.refreshError
		)
			return;
		return this.run({
			kind: "undo",
			decisionId,
			request: { idempotencyKey: createIdempotencyKey() },
		});
	}
	async retry() {
		if (
			this.state.retry &&
			!this.state.busy &&
			!this.state.refreshing &&
			!this.state.terminal
		)
			return this.run(this.state.retry);
	}
	private async run(command: RetryCommand) {
		// Set the guard before the first await: keyboard, pointer and clicks share one lock.
		this.update({ busy: true, error: null, notice: "" });
		try {
			this.client.live?.journal.write(command);
			if (command.kind === "decide") {
				const item = this.state.queue.find(
					(candidate) => candidate.track.trackId === command.request.trackId,
				);
				if (!item && !this.client.live)
					throw new Error(
						"The review queue changed. Reload the session to continue.",
					);
				const result = ReviewResultSchema.parse(
					await this.client.decide(command.request),
				);
				if (
					result.trackId !== command.request.trackId ||
					result.action !== command.request.action ||
					result.exposureId !== command.request.exposureId ||
					result.idempotencyKey !== command.request.idempotencyKey
				)
					throw new Error(
						"The decision response did not match this song. Retry to reconcile the command.",
					);
				if (result.status === "FAILED_TERMINAL")
					throw new TerminalReviewError(
						result.error?.message ??
							"This decision needs account recovery before review can continue.",
					);
				if (result.status !== "COMPLETE")
					throw new Error(
						result.error?.message ??
							"This decision is still settling. Retry to check its status.",
					);
				this.update({ departure: result.action });
				await new Promise<void>((resolve) =>
					setTimeout(resolve, this.settleMs),
				);
				this.update({
					queue: this.state.queue.filter(
						(candidate) => candidate.track.trackId !== command.request.trackId,
					),
					history: [
						{ item: item ?? null, result },
						...this.state.history.filter(
							(entry) => entry.result.decisionId !== result.decisionId,
						),
					],
					noticeUndoId: result.canUndo ? result.decisionId : null,
					noticeRevision: this.state.noticeRevision + 1,
					notice: `${actionPast[result.action]} “${item?.track.title ?? result.trackId}”${result.mode === "demo" ? " in this demo" : ""}.`,
					retry: null,
				});
			} else {
				const entry = this.state.history.find(
					(candidate) => candidate.result.decisionId === command.decisionId,
				);
				if (!entry && !this.client.live)
					throw new Error("This decision could not be found.");
				const result = ReviewResultSchema.parse(
					await this.client.undo(command.decisionId, command.request),
				);
				if (
					result.decisionId !== command.decisionId ||
					(entry && result.trackId !== entry.result.trackId)
				)
					throw new Error(
						"The restoration response did not match this decision.",
					);
				if (result.status === "FAILED_TERMINAL")
					throw new TerminalReviewError(
						result.error?.message ??
							"Restoration needs account recovery before review can continue.",
					);
				if (result.status !== "UNDONE")
					throw new Error(
						result.error?.message ??
							"Restoration is still settling. Retry to check its status.",
					);
				this.update({
					queue: [
						...(!this.client.live && entry?.item ? [entry.item] : []),
						...this.state.queue.filter(
							(candidate) => candidate.track.trackId !== result.trackId,
						),
					],
					history: this.state.history.map((candidate) =>
						candidate === entry ? { ...candidate, result } : candidate,
					),
					noticeUndoId: null,
					noticeRevision: this.state.noticeRevision + 1,
					notice: `Restored “${entry?.item?.track.title ?? result.trackId}” to your queue.`,
					retry: null,
				});
			}
			if (this.client.live) {
				try {
					this.client.live.journal.clear();
					this.applySnapshot(await this.client.live.snapshot());
				} catch (error) {
					this.update({
						refreshError: `Your command was confirmed. Refresh the library before continuing: ${errorMessage(error)}`,
					});
				}
			}
		} catch (error) {
			this.update({
				terminal:
					error instanceof TerminalReviewError ||
					(error instanceof ApiError && error.error.retryable === false),
				error:
					error instanceof Error
						? error.message
						: "Something went wrong. Your decision is saved for retry.",
				retry: command,
			});
			if (this.state.terminal && this.client.live) {
				try {
					this.client.live.journal.write({
						...command,
						terminal: !isUnauthorized(error),
					});
				} catch {
					/* Keep the original error if storage is unavailable. */
				}
			}
		} finally {
			this.update({ busy: false, departure: null });
		}
	}
}
