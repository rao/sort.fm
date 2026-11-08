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
import type {TeachReads,TeachingState} from '../components/teach/status';
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
	scope: 'research'|'teach' = 'research',
): CalibrationJournal {
	const key = `sortfm:${scope === 'teach' ? 'teach' : 'calibration'}:pending:v1:${encodeURIComponent(ownerId)}`;
	const experimentKey = `sortfm:calibration:batch3:pending:v1:${encodeURIComponent(ownerId)}`;
	const readSession = (): CalibrationSession => {
		if(scope==='teach')return 'ordinary';
		const saved = storage.getItem(`${key}:session`);
		return saved === "batch2" || saved === "batch3" ? saved : "ordinary";
	};
	const commandKey = (session = readSession()) => {
		if(scope==='teach'&&session!=='ordinary')throw new Error('Teach only supports ordinary preferences.');
		return session === "batch3" ? experimentKey : key;
	};
	return {
  readSession,
  selectSession:(session)=>{if(scope==='teach'){commandKey(session);return;}storage.setItem(`${key}:session`,session);},
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
	ordinary?: TeachReads,
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
	async function teachingStatus():Promise<TeachingState|undefined>{
		if(!ordinary)return undefined;
		try{return {status:await ordinary.status(),warning:null};}
		catch(error){if(isUnauthorized(error))throw error;return {status:null,warning:'Feedback synchronization could not be checked. Your saved preferences are retained.'};}
	}
	return {
		ownerId,
		journal,
		async snapshot(selection:CalibrationSession="ordinary") {
			await assertOwner();
			if(ordinary){
				if(selection!=='ordinary')throw new Error('Research sessions are separate from Teach.');
				const [queue,history,teaching]=await Promise.all([api.calibrationQueue({limit:20}),ordinary.history(),teachingStatus()]);
				await assertOwner();
				return {queue,history,teaching,metrics:null,warning:null,batch:null,experiment:null};
			}
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
		async startBatch(seed=42){if(ordinary)throw new Error("Research sessions are separate from Teach.");await assertOwner();const existing=(await api.calibrationBatch()).batch;return existing??api.calibrationBatchCreate({seed});},
  async skip(request:CalibrationBatchSkip,selection:CalibrationSession="batch2"){if(ordinary)throw new Error('Unsure does not save a label.');await assertOwner();return selection==="batch3"?api.calibrationExperimentSkip(request):api.calibrationBatchSkip(request);},
		async label(request: CalibrationLabelRequest) {
			await assertOwner();
			return api.calibrationLabel(request);
		},
		async undo(labelId: string, request: UndoRequest) {
			await assertOwner();
			return api.calibrationUndo(labelId, request);
		},
		async teachingStatus() { await assertOwner(); const value=await teachingStatus(); await assertOwner(); return value; },
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
