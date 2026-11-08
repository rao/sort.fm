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
	type LiveDetails,
	type LiveReviewSnapshot,
	type LibrarySummary,
	type InsightsData,
	isEmptyModelEvaluation,
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
	retraining: boolean;
	retrainError: string | null;
	retrainNotice: string;
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
	unavailable: boolean;
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
		retraining: false,
		retrainError: null,
		retrainNotice: "",
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
		unavailable: false,
		retry: null,
		notice: "",
		noticeUndoId: null,
		noticeRevision: 0,
	};
	private listeners = new Set<() => void>();
	private ownerId: string | null;
	private readRevision = 0;
	constructor(
		private client: ReviewClient,
		private settleMs = 0,
	) {
		this.ownerId = client.live?.session.user?.id ?? null;
	}
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
	async load(options: { deferDetails?: boolean } = {}) {
		if (
			this.state.loading ||
			this.state.busy ||
			this.state.retraining ||
			this.state.bootstrap
		)
			return;
		const revision = ++this.readRevision;
		this.update({ loading: true, error: null });
		try {
			if (this.client.live) {
				const pending = this.client.live.journal.read();
				// A fresh review card needs no optional inspector/history reads.
				// Recovery still waits for history before allowing another command.
				if (options.deferDetails && !pending) {
					this.applyReviewSnapshot(await this.client.live.reviewSnapshot());
					void this.refreshDetails(revision);
					return;
				}
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
		const previous = this.state.bootstrap;
		const sameOwner =
			snapshot.session.mode === "spotify" &&
			snapshot.session.user?.id === this.ownerId &&
			previous?.session.mode === "spotify" &&
			previous.session.user?.id === this.ownerId;
		// An unavailable optional read does not revoke confirmed metrics. An
		// explicit quarantine (present insights, null metrics) still clears them.
		const metrics =
			snapshot.insights === null
				? sameOwner
					? (previous?.metrics ?? null)
					: null
				: snapshot.insights.metrics;
		// Undo may requeue the same track with a new exposure. Preserve the
		// original prediction and policy attached to each historical decision.
		const known = new Map<string, QueueItem>();
		for (const entry of this.state.history)
			if (entry.item) known.set(entry.item.exposure.exposureId, entry.item);
		for (const item of [...this.state.queue, ...snapshot.queue.items])
			known.set(item.exposure.exposureId, item);
		this.update({
			bootstrap: {
				session: snapshot.session,
				queue: snapshot.queue,
				metrics,
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
							item: known.get(result.exposureId) ?? null,
						})),
			historyHasMore: snapshot.historyHasMore,
			warnings: snapshot.warnings,
			...(snapshot.insights?.metrics ? { retrainError: null } : {}),
			refreshError: null,
		});
	}
	private async refreshDetails(revision: number) {
		const live = this.client.live;
		if (!live || revision !== this.readRevision) return;
		try {
			const details = await live.details();
			if (revision !== this.readRevision) return;
			this.applyDetails(details);
		} catch (error) {
			if (revision === this.readRevision)
				this.update({ refreshError: errorMessage(error) });
		}
	}
	private applyReviewSnapshot(snapshot: LiveReviewSnapshot) {
		this.update({
			bootstrap: {
				session: snapshot.session,
				queue: snapshot.queue,
				metrics: this.state.bootstrap?.metrics ?? null,
				notice: "Connected to Spotify. Confirmed changes update your library.",
			},
			queue: snapshot.queue.items,
			summary: snapshot.summary,
			remaining: snapshot.queue.remaining,
			refreshError: null,
		});
	}
	private applyDetails(details: LiveDetails) {
		const bootstrap = this.state.bootstrap;
		if (
			bootstrap?.session.mode !== "spotify" ||
			bootstrap.session.user?.id !== this.ownerId
		)
			return;
		const known = new Map<string, QueueItem>();
		for (const entry of this.state.history)
			if (entry.item) known.set(entry.item.exposure.exposureId, entry.item);
		for (const item of this.state.queue)
			known.set(item.exposure.exposureId, item);
		// Background reads only update optional views. They cannot restore an old
		// queue, clear a command's journal/lock, or dismiss a foreground error.
		this.update({
			bootstrap: {
				...bootstrap,
				metrics:
					details.insights === null ? bootstrap.metrics : details.insights.metrics,
			},
			insights: details.insights,
			history:
				details.history === null
					? this.state.history
					: details.history.map((result) => ({
							result,
							item: known.get(result.exposureId) ?? null,
						})),
			historyHasMore:
				details.history === null ? this.state.historyHasMore : details.historyHasMore,
			warnings: details.warnings,
			...(details.insights?.metrics ? { retrainError: null } : {}),
		});
	}
	async retrain() {
		const live = this.client.live;
		if (
			!live ||
			!this.state.bootstrap ||
			this.state.busy ||
			this.state.retraining ||
			this.state.loading ||
			this.state.refreshing ||
			this.state.retry ||
			this.state.refreshError ||
			this.state.retrainError
		)
			return;
		this.readRevision++;
		this.update({ retraining: true, retrainError: null, retrainNotice: "" });
		try {
			const session = await live.api.session();
			if (session.mode !== "spotify" || session.user?.id !== this.ownerId)
				throw new Error("Your account changed. Reconnect before training.");
			const result = await live.api.retrain();
			if (
				result.userId !== this.ownerId ||
				result.modelVersion !== result.metrics.modelVersion ||
				result.trainedExamples !== result.metrics.trainedExamples ||
				(result.metrics.dataset === "synthetic" &&
					!isEmptyModelEvaluation(result.metrics))
			)
				throw new Error(
					"The training result does not match this account or model. Refresh server data to reconcile.",
				);
			this.update({
				bootstrap: { ...this.state.bootstrap!, metrics: result.metrics },
				insights: this.state.insights
					? { ...this.state.insights, metrics: result.metrics }
					: null,
				retrainNotice: `Server confirmed model ${result.modelVersion} at feedback revision ${result.feedbackRevision}. Current song scores retain their exposure-time version.`,
			});
			try {
				this.applySnapshot(await live.snapshot());
			} catch (error) {
				this.update({
					refreshError: `Your model was confirmed. Refresh the queue before continuing: ${errorMessage(error)}`,
				});
			}
		} catch (error) {
			this.update({
				retrainError: `${errorMessage(error)} Refresh server data to check the current model before requesting another fit.`,
			});
		} finally {
			this.update({ retraining: false });
		}
	}
	async refresh() {
		if (
			!this.client.live ||
			!this.state.bootstrap ||
			this.state.loading ||
			this.state.busy ||
			this.state.retraining ||
			this.state.refreshing ||
			this.state.retry
		)
			return;
		this.readRevision++;
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
			this.state.retraining ||
			this.state.refreshing ||
			!this.state.retry
		)
			return;
		this.readRevision++;
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
			this.state.retraining ||
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
			this.state.retraining ||
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
			!this.state.retraining &&
			!this.state.refreshing &&
			!this.state.terminal
		)
			return this.run(this.state.retry);
	}
	dismissUnavailable() {
		if (this.state.unavailable)
			this.update({ unavailable: false, error: null });
	}
	private async run(command: RetryCommand) {
		const recovering = this.state.retry !== null;
		const revision = ++this.readRevision;
		let refreshDetails = false;
		let accepted = false;
		// Set the guard before the first await: keyboard, pointer and clicks share one lock.
		this.update({
			busy: true,
			error: null,
			notice: "",
			noticeUndoId: null,
			unavailable: false,
		});
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
				let result = ReviewResultSchema.parse(
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
				accepted = true;
				if (result.status === "PENDING" && this.client.live)
					result = await this.client.live.waitForSettlement(result, "COMPLETE");
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
					departure: null,
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
				let result: ReviewResult;
				try {
					result = ReviewResultSchema.parse(
						await this.client.undo(command.decisionId, command.request),
					);
					accepted = true;
				} catch (error) {
					if (
						!this.client.live ||
						!entry ||
						!(error instanceof ApiError) ||
						error.status !== 409 ||
						error.error.code !== "UNDO_PENDING" ||
						error.error.retryable !== true
					)
						throw error;
					accepted = true;
					result = await this.client.live.waitForSettlement(
						entry.result,
						"UNDONE",
					);
				}
				if (
					result.decisionId !== command.decisionId ||
					(entry &&
						(result.trackId !== entry.result.trackId ||
							result.exposureId !== entry.result.exposureId ||
							result.action !== entry.result.action ||
							result.idempotencyKey !== entry.result.idempotencyKey))
				)
					throw new Error(
						"The restoration response did not match this decision.",
					);
				if (result.status === "PENDING" && this.client.live && entry)
					result = await this.client.live.waitForSettlement(result, "UNDONE");
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
					this.update({ busy: false, refreshing: true, departure: null });
					this.applyReviewSnapshot(await this.client.live.reviewSnapshot());
					refreshDetails = true;
				} catch (error) {
					this.update({
						refreshError: `Your command was confirmed. Refresh the library before continuing: ${errorMessage(error)}`,
					});
				}
			}
		} catch (error) {
			// Batch reservation and exposure closure are checked under the owner lock
			// before inserting a decision. Only a fresh attempt can be discarded;
			// a retry must retain any earlier ambiguous outcome until history settles it.
			if (
				!recovering && !accepted && command.kind === "decide" && this.client.live &&
				error instanceof ApiError && error.status === 409 &&
				(error.error.code === "BATCH_TRACK_RESERVED" || error.error.code === "POLICY_EXPOSURE_CLOSED") &&
				error.error.retryable === false
			) {
				try {
					this.client.live.journal.clear();
				} catch {
					this.update({ retry: command, terminal: true, error: "This action was rejected, but its local recovery record could not be cleared. Review remains paused." });
					return;
				}
				this.update({
					retry: null, terminal: false, queue: [], error: null,
					notice: "This card is no longer available. Your action was not applied.",
					noticeRevision: this.state.noticeRevision + 1,
					refreshError: "Refreshing the queue after the rejected action.",
				});
				try {
					this.applySnapshot(await this.client.live.snapshot());
				} catch (refreshError) {
					this.update({ refreshError: errorMessage(refreshError) });
				}
				return;
			}
			// The frozen contract stub explicitly rejects before accepting a command.
			// No other terminal or ambiguous response proves that no mutation occurred.
			if (
				!recovering &&
				!accepted &&
				this.client.live &&
				error instanceof ApiError &&
				error.status === 501 &&
				error.error.code === "NOT_IMPLEMENTED"
			) {
				try {
					this.client.live.journal.clear();
					this.update({
						retry: null,
						terminal: false,
						unavailable: true,
						error:
							"This action is not available yet. No decision was accepted and your song has not changed. You can try again when the review service is enabled.",
					});
				} catch {
					this.update({
						retry: command,
						terminal: true,
						error:
							"The action is unavailable, but its local recovery record could not be cleared. Review remains paused.",
					});
				}
				return;
			}
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
			this.update({ busy: false, refreshing: false, departure: null });
		}
		if (refreshDetails) void this.refreshDetails(revision);
	}
}
