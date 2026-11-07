import {
	ACTION_SEMANTICS,
	ReviewResultSchema,
	type DemoBootstrap,
	type QueueResult,
	type ReviewAction,
	type ReviewRequest,
	type ReviewResult,
	type UndoRequest,
} from "@sortfm/contracts";
import { ApiError, createIdempotencyKey } from "@sortfm/contracts/client";
import type { ReviewClient } from "../data/demo-client";
export type QueueItem = QueueResult["items"][number];
export type HistoryEntry = { item: QueueItem; result: ReviewResult };
class TerminalReviewError extends Error {}
type RetryCommand =
	| { kind: "decide"; request: ReviewRequest }
	| { kind: "undo"; decisionId: string; request: UndoRequest };
export type ReviewState = {
	bootstrap: DemoBootstrap | null;
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
			const bootstrap = await this.client.demoBootstrap();
			this.update({ bootstrap, queue: bootstrap.queue.items });
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
	async decide(action: ReviewAction) {
		const item = this.state.queue[0];
		if (!item || this.state.busy || this.state.retry) return;
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
		if (this.state.busy || this.state.retry) return;
		return this.run({
			kind: "undo",
			decisionId,
			request: { idempotencyKey: createIdempotencyKey() },
		});
	}
	async retry() {
		if (this.state.retry && !this.state.busy && !this.state.terminal)
			return this.run(this.state.retry);
	}
	private async run(command: RetryCommand) {
		// Set the guard before the first await: keyboard, pointer and clicks share one lock.
		this.update({ busy: true, error: null, notice: "" });
		try {
			if (command.kind === "decide") {
				const item = this.state.queue.find(
					(candidate) => candidate.track.trackId === command.request.trackId,
				);
				if (!item)
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
						(candidate) => candidate.track.trackId !== item.track.trackId,
					),
					history: [{ item, result }, ...this.state.history],
					noticeUndoId: result.canUndo ? result.decisionId : null,
					noticeRevision: this.state.noticeRevision + 1,
					notice: `${actionPast[result.action]} “${item.track.title}”${result.mode === "demo" ? " in this demo" : ""}.`,
					retry: null,
				});
			} else {
				const entry = this.state.history.find(
					(candidate) => candidate.result.decisionId === command.decisionId,
				);
				if (!entry) throw new Error("This decision could not be found.");
				const result = ReviewResultSchema.parse(
					await this.client.undo(command.decisionId, command.request),
				);
				if (
					result.decisionId !== command.decisionId ||
					result.trackId !== entry.item.track.trackId
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
						entry.item,
						...this.state.queue.filter(
							(candidate) =>
								candidate.track.trackId !== entry.item.track.trackId,
						),
					],
					history: this.state.history.map((candidate) =>
						candidate === entry ? { ...entry, result } : candidate,
					),
					noticeUndoId: null,
					noticeRevision: this.state.noticeRevision + 1,
					notice: `Restored “${entry.item.track.title}” to your queue.`,
					retry: null,
				});
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
		} finally {
			this.update({ busy: false, departure: null });
		}
	}
}
