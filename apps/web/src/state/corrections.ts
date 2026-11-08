import {
	CalibrationLabelResultSchema,
	SpotifyTrackIdSchema,
	type CalibrationLabelResult,
	type ReviewResult,
} from "@sortfm/contracts";
import { ApiError, createIdempotencyKey } from "@sortfm/contracts/client";
import type {
	CorrectionClient,
	CorrectionCommand,
} from "../data/correction-client";
import { errorMessage } from "../data/live-client";

export type CorrectionState = {
	ready: boolean;
	busy: boolean;
	refreshing: boolean;
	pending: CorrectionCommand | null;
	labels: CalibrationLabelResult[];
	historyHasMore: boolean;
	error: string | null;
	notice: string;
};
export function correctionLocked(state: CorrectionState) {
	return (
		!state.ready ||
		state.busy ||
		state.refreshing ||
		!!state.pending ||
		!!state.error
	);
}
export function latestSkipDecisions(results: ReviewResult[]) {
	const latest = new Map<string, ReviewResult>();
	for (const result of results) {
		const previous = latest.get(result.trackId);
		if (
			!previous ||
			Date.parse(result.createdAt) > Date.parse(previous.createdAt)
		)
			latest.set(result.trackId, result);
	}
	return new Set(
		[...latest.values()]
			.filter(
				(result) =>
					result.mode === "spotify" &&
					result.status === "COMPLETE" &&
					result.action === "SKIP" &&
					result.label === null,
			)
			.map((result) => result.decisionId),
	);
}
function matches(command: CorrectionCommand, result: CalibrationLabelResult) {
	return (
		result.trackId === command.trackId &&
		(command.kind === "correct"
			? result.idempotencyKey === command.request.idempotencyKey &&
				result.submittedLabel === 1
			: result.labelId === command.labelId && result.state !== "active")
	);
}
function rejectedBeforeCommit(error: unknown) {
	return (
		error instanceof ApiError &&
		error.error.retryable === false &&
		((error.status === 404 && error.error.code === "DECISION_NOT_FOUND") ||
			(error.status === 409 &&
				[
					"CALIBRATION_NOT_ELIGIBLE",
					"BATCH_TRACK_RESERVED",
					"MUTATION_PENDING",
					"CALIBRATION_LABEL_ACTIVE",
					"STALE_CALIBRATION_LABEL",
				].includes(error.error.code)))
	);
}
export class CorrectionStore {
	private state: CorrectionState = {
		ready: false,
		busy: false,
		refreshing: false,
		pending: null,
		labels: [],
		historyHasMore: false,
		error: null,
		notice: "",
	};
	private listeners = new Set<() => void>();
	constructor(private client: CorrectionClient) {}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<CorrectionState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	async load() {
		if (!this.state.ready) await this.refresh();
	}
	async refresh() {
		if (this.state.busy || this.state.refreshing) return;
		this.update({ refreshing: true });
		try {
			const pending = this.client.journal.read();
			this.update({ pending });
			const history = await this.client.history();
			const settled =
				pending && history.items.find((result) => matches(pending, result));
			if (settled) this.client.journal.clear();
			this.update({
				ready: true,
				labels: history.items,
				historyHasMore: !!history.nextCursor,
				pending: settled ? null : pending,
				error:
					pending && !settled
						? "The saved preference command is not confirmed yet. Check its outcome or retry the original request."
						: null,
				...(settled
					? {
							notice:
								"Saved preference outcome confirmed. Spotify and the original Skip are unchanged.",
						}
					: {}),
			});
		} catch (error) {
			this.update({ error: errorMessage(error) });
		} finally {
			this.update({ refreshing: false });
		}
	}
	async correct(decision: ReviewResult) {
		if (
			correctionLocked(this.state) ||
			decision.mode !== "spotify" ||
			decision.action !== "SKIP" ||
			decision.status !== "COMPLETE" ||
			decision.label !== null ||
			!SpotifyTrackIdSchema.safeParse(decision.trackId).success ||
			this.state.labels.some(
				(label) =>
					label.trackId === decision.trackId && label.state === "active",
			)
		)
			return;
		return this.run({
			kind: "correct",
			trackId: decision.trackId,
			request: {
				decisionId: decision.decisionId,
				idempotencyKey: createIdempotencyKey(),
				label: 1,
			},
		});
	}
	async undo(labelId: string) {
		const label = this.state.labels.find(
			(candidate) =>
				candidate.labelId === labelId &&
				candidate.state === "active" &&
				candidate.canUndo,
		);
		if (correctionLocked(this.state) || !label) return;
		return this.run({
			kind: "undo",
			trackId: label.trackId,
			labelId,
			request: { idempotencyKey: createIdempotencyKey() },
		});
	}
	async retry() {
		if (this.state.pending && !this.state.busy && !this.state.refreshing)
			return this.run(this.state.pending);
	}
	private async run(command: CorrectionCommand) {
		const recovering = this.state.pending !== null;
		this.update({ busy: true, error: null, notice: "" });
		try {
			this.client.journal.write(command);
			this.update({ pending: command });
			const result = CalibrationLabelResultSchema.parse(
				command.kind === "correct"
					? await this.client.correct(command.request)
					: await this.client.undo(command.labelId, command.request),
			);
			if (!matches(command, result))
				throw new Error(
					"The preference response did not match the saved request. Check its outcome before continuing.",
				);
			this.client.journal.clear();
			this.update({
				pending: null,
				labels: [
					result,
					...this.state.labels.filter(
						(label) => label.labelId !== result.labelId,
					),
				],
				notice:
					result.state === "active"
						? "Remove preference saved. Spotify and the original Skip are unchanged. This is not a C2 reward."
						: `Preference label ${result.state}. Spotify and the original Skip are unchanged.`,
			});
		} catch (error) {
			if (!recovering && rejectedBeforeCommit(error)) {
				try {
					this.client.journal.clear();
					this.update({
						pending: null,
						error: `The preference change was not accepted. Check preference history before continuing: ${errorMessage(error)}`,
					});
					return;
				} catch (storageError) {
					this.update({ pending: command, error: errorMessage(storageError) });
					return;
				}
			}
			this.update({ pending: command, error: errorMessage(error) });
		} finally {
			this.update({ busy: false });
		}
	}
}
