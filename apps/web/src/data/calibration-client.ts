import {CalibrationBatchSkipSchema,type CalibrationBatchSkip} from '@sortfm/contracts';
import {
	CalibrationLabelRequestSchema,
	type CalibrationExperiment,
	type CalibrationQueueResult,
	UndoRequestSchema,
	UuidSchema,
	type AccountSession,
	type CalibrationLabelRequest,
	type UndoRequest,
	type ModelMetrics,
} from "@sortfm/contracts";
import { ApiError } from "@sortfm/contracts/client";
import {
	errorMessage,
	isEmptyModelEvaluation,
	isUnauthorized,
	type LiveApi,
} from "./live-client";
export type CalibrationCommand =
	| { kind: "label"; request: CalibrationLabelRequest }
	| { kind: "undo"; labelId: string; request: UndoRequest }
 | { kind: "skip"; request: CalibrationBatchSkip };
export type CalibrationSession = "ordinary" | "batch2" | "batch3";
export interface CalibrationJournal {
 readSession?():CalibrationSession;
 selectSession?(session:CalibrationSession):void;
	read(session?: CalibrationSession): CalibrationCommand | null;
	write(command: CalibrationCommand, session?: CalibrationSession): void;
	clear(session?: CalibrationSession): void;
}
export function calibrationJournal(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
	ownerId: string,
): CalibrationJournal {
	const key = `sortfm:calibration:pending:v1:${encodeURIComponent(ownerId)}`;
	const experimentKey = `sortfm:calibration:batch3:pending:v1:${encodeURIComponent(ownerId)}`;
	const readSession = (): CalibrationSession => {
		const saved = storage.getItem(`${key}:session`);
		return saved === "batch2" || saved === "batch3" ? saved : "ordinary";
	};
	const commandKey = (session = readSession()) => session === "batch3" ? experimentKey : key;
	return {
  readSession,
  selectSession:(session)=>storage.setItem(`${key}:session`,session),
		read(session) {
			const raw = storage.getItem(commandKey(session));
			if (!raw) return null;
			const value = JSON.parse(raw);
			if (value.kind === "skip") return {kind:"skip",request:CalibrationBatchSkipSchema.parse(value.request)};
			if (value.kind === "label")
				return {
					kind: "label",
					request: CalibrationLabelRequestSchema.parse(value.request),
				};
			if (value.kind === "undo")
				return {
					kind: "undo",
					labelId: UuidSchema.parse(value.labelId),
					request: UndoRequestSchema.parse(value.request),
				};
			throw new Error(
				"The saved calibration command is unreadable. Labeling is paused for recovery.",
			);
		},
		write: (command, session) => storage.setItem(commandKey(session), JSON.stringify(command)),
		clear: (session) => storage.removeItem(commandKey(session)),
	};
}
// Deliberately exclude every cleanup and player mutation method from this boundary.
type CalibrationApi = Pick<
	LiveApi,
	| "session"
	| "calibrationQueue"
 | "calibrationBatch" | "calibrationBatchCreate" | "calibrationBatchSkip"
 | "calibrationExperiment" | "calibrationExperimentSkip"
	| "calibrationLabel"
	| "calibrationUndo"
	| "calibrationHistory"
	| "insights"
	| "retrain"
>;
export function createCalibrationClient(
	api: CalibrationApi,
	session: AccountSession,
	journal: CalibrationJournal,
) {
	if (session.mode !== "spotify" || !session.user)
		throw new Error("Connect Spotify to label your imported songs.");
	const ownerId = session.user.id;
	async function assertOwner() {
		const current = await api.session();
		if (current.mode !== "spotify" || current.user?.id !== ownerId)
			throw new ApiError(401, {
				code: "SESSION_CHANGED",
				message: "Your account changed. Reconnect before labeling.",
				retryable: false,
			});
		return current;
	}
	return {
		ownerId,
		journal,
		async snapshot(selection:CalibrationSession="ordinary") {
			await assertOwner();
			if (selection === "batch3") {
				const { batch: experiment } = await api.calibrationExperiment();
				const ready = experiment?.phase === "ready" ? experiment : null;
				const history = ready ? await api.calibrationHistory() : { items: [], nextCursor: null };
				await assertOwner();
				const queue: CalibrationQueueResult = ready?.queue ?? { contractVersion: "1.0.0", mode: "calibration", items: [], remaining: 0, nextCursor: null, fallbackReason: null };
				return { queue, history: { ...history, items: history.items.filter(item => ready?.entries.some(entry => entry.trackId === item.trackId)) }, metrics: null, warning: null, batch: null, experiment };
			}
			const batch=selection==="batch2"?(await api.calibrationBatch()).batch:null;
   if(selection==="batch2"&&!batch)throw new Error("Batch 2 has not been created. Start the saved session below.");
			const [queue, history, model] = await Promise.all([
				batch?Promise.resolve(batch.queue):api.calibrationQueue({ limit: 20 }),
				api.calibrationHistory(),
				api
					.insights()
					.then((data) => ({ data, error: null }))
					.catch((error: unknown) => ({ data: null, error })),
			]);
			if (isUnauthorized(model.error)) throw model.error;
			await assertOwner();
			let metrics: ModelMetrics | null | undefined = model.data?.metrics;
			let warning = model.error
				? `Model data unavailable: ${errorMessage(model.error)}`
				: null;
			if (
				metrics?.dataset === "synthetic" &&
				!isEmptyModelEvaluation(metrics)
			) {
				metrics = null;
				warning =
					"Synthetic model metrics were excluded from your personal model.";
			}
			return { queue, history, metrics, warning, batch, experiment: null as CalibrationExperiment | null };
		},
		async startBatch(seed=42){await assertOwner();const existing=(await api.calibrationBatch()).batch;return existing??api.calibrationBatchCreate({seed});},
  async skip(request:CalibrationBatchSkip,selection:CalibrationSession="batch2"){await assertOwner();return selection==="batch3"?api.calibrationExperimentSkip(request):api.calibrationBatchSkip(request);},
		async label(request: CalibrationLabelRequest) {
			await assertOwner();
			return api.calibrationLabel(request);
		},
		async undo(labelId: string, request: UndoRequest) {
			await assertOwner();
			return api.calibrationUndo(labelId, request);
		},
		async retrain() {
			await assertOwner();
			const result = await api.retrain();
			await assertOwner();
			if (
				result.userId !== ownerId ||
				result.modelVersion !== result.metrics.modelVersion ||
				result.trainedExamples !== result.metrics.trainedExamples ||
				(result.metrics.dataset === "synthetic" &&
					!isEmptyModelEvaluation(result.metrics))
			)
				throw new Error(
					"The fit result does not match this account or model. Refresh model data before another fit.",
				);
			return result;
		},
	};
}
export type CalibrationClient = ReturnType<typeof createCalibrationClient>;
