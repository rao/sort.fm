import {CalibrationBatchSchema,CalibrationExperimentReadySchema,type CalibrationBatch,type CalibrationExperiment} from '@sortfm/contracts';
import type {TeachingState} from '../components/teach/status';
import type {CalibrationSession} from '../data/calibration-client';
import {
	CalibrationLabelResultSchema,
	type CalibrationLabelResult,
	type CalibrationQueueResult,
	type ModelMetrics,
} from "@sortfm/contracts";
import { ApiError, createIdempotencyKey } from "@sortfm/contracts/client";
import type {
	CalibrationClient,
	CalibrationCommand,
} from "../data/calibration-client";
import { errorMessage } from "../data/live-client";
export type CalibrationAction = 0 | 1 | "skip" | "undo";
export function calibrationActionFromKey(
	key: string,
): CalibrationAction | null {
	return key === "ArrowRight"
		? 0
		: key === "ArrowLeft"
			? 1
			: key === "ArrowUp"
				? "skip"
				: key.toLowerCase() === "z"
					? "undo"
					: null;
}
export function calibrationActionFromDrag(
	x: number,
	y: number,
): Exclude<CalibrationAction, "undo"> | null {
	if (Math.abs(x) >= 75 && Math.abs(x) > Math.abs(y)) return x > 0 ? 0 : 1;
	return y <= -75 && Math.abs(y) > Math.abs(x) ? "skip" : null;
}
type Item = CalibrationQueueResult["items"][number];
export type CalibrationState = {
 teaching?:TeachingState;
 session:CalibrationSession;
 batch:CalibrationBatch|null;
 experiment:CalibrationExperiment|null;
	ready: boolean;
	loading: boolean;
	busy: boolean;
	refreshing: boolean;
	retraining: boolean;
	error: string | null;
	refreshError: string | null;
	retrainError: string | null;
	notice: string;
	pending: CalibrationCommand | null;
	queue: Item[];
	remaining: number | null;
	history: CalibrationLabelResult[];
	historyHasMore: boolean;
	skipped: number;
	metrics: ModelMetrics | null;
	modelWarning: string | null;
	fallbackReason: string | null;
	tracks: Record<string, Item["track"]>;
};
export function calibrationLocked(state: CalibrationState) {
	return (
		!state.ready ||
		(state.session === "batch3" && state.experiment?.phase !== "ready") ||
		state.loading ||
		state.busy ||
		state.refreshing ||
		state.retraining ||
		!!state.pending ||
		!!state.refreshError
	);
}
function matches(command: CalibrationCommand, result: CalibrationLabelResult) {
	if(command.kind==="skip")return false;
 return command.kind === "label"
		? result.idempotencyKey === command.request.idempotencyKey &&
				result.trackId === command.request.trackId &&
				result.exposureId === command.request.exposureId &&
				result.submittedLabel === command.request.label
		: result.labelId === command.labelId && result.state !== "active";
}
// A1/D reject these eligibility conflicts before committing a label or Undo.
// Unknown errors and idempotency conflicts remain ambiguous. Never discard an
// already-pending command: an earlier attempt may have committed successfully.
function rejectedBeforeCommit(error: unknown) {
	return (
		error instanceof ApiError &&
		error.status === 409 &&
		error.error.retryable === false &&
		[
			"STALE_EXPOSURE",
			"EXPOSURE_ALREADY_CONSUMED",
			"EXPOSURE_PURPOSE_MISMATCH",
			"EXPOSURE_TRACK_MISMATCH",
			"CALIBRATION_NOT_ELIGIBLE",
			"CALIBRATION_LABEL_ACTIVE",
			"TRACK_NOT_IN_LIBRARY",
			"STALE_CALIBRATION_LABEL",
			"MUTATION_PENDING",
   "BATCH_ITEM_NOT_PENDING", "BATCH_TRACK_RESERVED",
		].includes(error.error.code)
	);
}
export class CalibrationStore {
	private state: CalibrationState = {
		session:"ordinary",batch:null,experiment:null,
		ready: false,
		loading: false,
		busy: false,
		refreshing: false,
		retraining: false,
		error: null,
		refreshError: null,
		retrainError: null,
		notice: "",
		pending: null,
		queue: [],
		remaining: null,
		history: [],
		historyHasMore: false,
		skipped: 0,
		metrics: null,
		modelWarning: null,
		fallbackReason: null,
		tracks: {},
	};
	private listeners = new Set<() => void>();
	private skipped = new Set<string>();
	private teachingStatusRequest = 0;
	constructor(private client: CalibrationClient) {}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<CalibrationState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private restoreJournal() {
		// Storage can be denied by the browser. Read both values inside the
		// caller's recovery boundary; never replace an unread command or session.
		const session = this.client.journal.readSession?.() ?? this.state.session;
		const pending = this.client.journal.read(session);
		this.update({ pending, session });
	}
	private async reconcile() {
		const snapshot = await this.client.snapshot(this.state.session);
		const pending = this.state.pending;
		const collection = snapshot.experiment?.phase === "ready" ? snapshot.experiment : snapshot.batch;
		const settled = pending && (pending.kind==="skip" ? collection?.entries.some(e=>e.exposureId===pending.request.exposureId&&e.status==="skipped") : snapshot.history.items.find((item) => matches(pending, item)));
		if (settled) this.client.journal.clear(this.state.session);
		const hideTracks = this.state.session === "batch3" &&
			(snapshot.experiment?.phase !== "ready" || snapshot.experiment.batchId !== this.state.experiment?.batchId);
		const tracks = hideTracks ? {} as CalibrationState["tracks"] : { ...this.state.tracks };
		for (const item of snapshot.queue.items)
			tracks[item.track.trackId] = item.track;
		this.update({
			ready: true,
   teaching:"teaching" in snapshot ? snapshot.teaching : undefined,
   batch:snapshot.batch,
   experiment:snapshot.experiment,
   skipped:collection?collection.groups.reduce((n,g)=>n+g.skipped,0):this.skipped.size,
			queue: snapshot.queue.items.filter(
				(item) => !this.skipped.has(item.track.trackId),
			),
			remaining: snapshot.queue.remaining,
			history: snapshot.history.items,
			historyHasMore: !!snapshot.history.nextCursor,
			tracks,
			fallbackReason: snapshot.queue.fallbackReason,
			metrics:
				snapshot.metrics === undefined ? this.state.metrics : snapshot.metrics,
			modelWarning: snapshot.warning,
			...(snapshot.metrics ? { retrainError: null } : {}),
			pending: settled ? null : pending,
			error:
				pending && !settled
					? "An unfinished calibration command needs recovery. Check its saved outcome or retry the original request."
					: null,
			refreshError: null,
			...(settled
				? {
						notice: typeof settled==="object" ? `Saved calibration outcome: ${settled.state}. No Spotify changes.` : "Saved Skip confirmed. No label was saved.",
					}
				: {}),
		});
	}
	async load() {
		if (this.state.ready || this.state.loading || this.state.busy) return;
		await this.refresh();
	}
	async refresh() {
		if (
			this.state.loading ||
			this.state.busy ||
			this.state.refreshing ||
			this.state.retraining
		)
			return;
		this.update({ refreshing: true, loading: !this.state.ready });
		try {
			this.restoreJournal();
			await this.reconcile();
		} catch (error) {
			this.update({
				error: errorMessage(error),
				refreshError: errorMessage(error),
			});
		} finally {
			this.update({ refreshing: false, loading: false });
		}
	}
	async skip() {
		if (calibrationLocked(this.state)) return;
		const item = this.state.queue[0];
		if (!item) return;
		if(this.state.session!=="ordinary")return this.run({kind:"skip",request:{exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()}});
		this.skipped.add(item.track.trackId);
		this.update({
			queue: this.state.queue.slice(1),
			skipped: this.skipped.size,
			notice: "Skipped in this session. No label was saved.",
		});
	}
	async selectSession(session:CalibrationSession,seed=42){
  if(this.state.busy||this.state.loading||this.state.refreshing||this.state.retraining||this.state.pending)return;
  try{this.restoreJournal();}catch(error){this.update({error:errorMessage(error),refreshError:errorMessage(error)});return;}
  if(this.state.pending)return;
  this.update({busy:true,error:null});
  try{
   if(session==="batch2")await this.client.startBatch(seed);
   const pending=this.client.journal.read(session);this.client.journal.selectSession?.(session);this.skipped.clear();this.update({session,batch:null,experiment:null,pending,skipped:0,notice:"",queue:[],history:[],tracks:{},metrics:null,remaining:null,refreshError:"Loading the selected calibration session."});await this.reconcile();
  }catch(error){this.update({error:errorMessage(error)});}finally{this.update({busy:false});}
 }
 async refreshTeachingStatus(){
  if(!this.state.teaching||this.state.busy||this.state.refreshing||this.state.loading)return;
  const history=this.state.history,request=++this.teachingStatusRequest;
  const current=()=>request===this.teachingStatusRequest&&this.state.history===history&&!this.state.busy&&!this.state.refreshing;
  try{const teaching=await this.client.teachingStatus();if(current())this.update({teaching});}
  catch{if(current())this.update({teaching:{status:null,warning:'Feedback synchronization could not be checked.'}});}
 }

	async showSkipped() {
		if (calibrationLocked(this.state)||this.state.session!=="ordinary") return;
		this.skipped.clear();
		this.update({ skipped: 0 });
		await this.refresh();
	}
	async label(label: 0 | 1) {
		if (calibrationLocked(this.state)) return;
		const item = this.state.queue[0];
		if (!item) return;
		return this.run({
			kind: "label",
			request: {
				trackId: item.track.trackId,
				exposureId: item.exposure.exposureId,
				label,
				idempotencyKey: createIdempotencyKey(),
			},
		});
	}
	async undo(labelId: string) {
		if (
			calibrationLocked(this.state) ||
			!this.state.history.some(
				(item) =>
					item.labelId === labelId && item.canUndo && item.state === "active",
			)
		)
			return;
		return this.run({
			kind: "undo",
			labelId,
			request: { idempotencyKey: createIdempotencyKey() },
		});
	}
	async retry() {
		if (
			!this.state.pending ||
			(this.state.session === "batch3" && this.state.experiment?.phase !== "ready") ||
			this.state.busy ||
			this.state.loading ||
			this.state.refreshing ||
			this.state.retraining
		)
			return;
		return this.run(this.state.pending);
	}
	private async run(command: CalibrationCommand) {
		const recovering = this.state.pending !== null;
		this.update({ busy: true, error: null, notice: "" });
		try {
			this.client.journal.write(command, this.state.session);
			this.update({ pending: command });
			if(command.kind==="skip"){
    const result=await this.client.skip(command.request,this.state.session);
    const batch=this.state.session==="batch3"?CalibrationExperimentReadySchema.parse(result):CalibrationBatchSchema.parse(result);
    if(!batch.entries.some(e=>e.exposureId===command.request.exposureId&&e.status==="skipped"))throw new Error("The saved Skip outcome could not be verified.");
    this.client.journal.clear(this.state.session);this.update({pending:null,...("phase" in batch?{experiment:batch}:{batch}),notice:this.state.session==="batch3"?"Skipped without a label. Evaluation songs stay reserved and are never replaced.":"Skipped without a label. A replacement is drawn from the same group when available."});
    try{await this.reconcile();}catch(error){this.update({refreshError:errorMessage(error)});}
    return;
   }
			const result = CalibrationLabelResultSchema.parse(
				command.kind === "label"
					? await this.client.label(command.request)
					: await this.client.undo(command.labelId, command.request),
			);
			if (!matches(command, result))
				throw new Error(
					"The calibration response does not match the original request. Check its saved outcome before continuing.",
				);
			this.client.journal.clear(this.state.session);
			this.update({
				pending: null,
				history: [
					result,
					...this.state.history.filter(
						(item) => item.labelId !== result.labelId,
					),
				],
				notice:
					this.state.teaching
						? result.state === "active"
							? `Saved: ${result.label === 0 ? "Keep" : "Discard"}. Spotify stays unchanged.`
							: "Answer withdrawn. Spotify stays unchanged."
						: result.state === "active"
						? `Saved: would ${result.label === 0 ? "keep" : "remove"}. Spotify is unchanged.`
						: `Calibration label ${result.state}. Spotify is unchanged.`,
			});
			try {
				await this.reconcile();
			} catch (error) {
				this.update({
					refreshError: `Your label change was confirmed. Refresh calibration before continuing: ${errorMessage(error)}`,
				});
			}
		} catch (error) {
			if (!recovering && rejectedBeforeCommit(error)) {
				try {
					this.client.journal.clear(this.state.session);
					this.update({
						pending: null,
						error: null,
						refreshError: `Your label change was not accepted. Refresh calibration for a fresh selection: ${errorMessage(error)}`,
					});
				} catch (storageError) {
					this.update({ error: errorMessage(storageError), pending: command });
				}
			} else {
				this.update({ error: errorMessage(error), pending: command });
			}
		} finally {
			this.update({ busy: false });
		}
	}
	async retrain() {
		if (this.state.session === "batch3" || calibrationLocked(this.state) || this.state.retrainError) return;
		this.update({ retraining: true, retrainError: null, notice: "" });
		try {
			const result = await this.client.retrain();
			this.update({
				metrics: result.metrics,
				notice: `Model ${result.modelVersion} confirmed at feedback revision ${result.feedbackRevision}.`,
			});
			try {
				await this.reconcile();
			} catch (error) {
				this.update({
					refreshError: `Your model was confirmed. Refresh calibration before continuing: ${errorMessage(error)}`,
				});
			}
		} catch (error) {
			this.update({
				retrainError: `${errorMessage(error)} Refresh model data before requesting another fit.`,
			});
		} finally {
			this.update({ retraining: false });
		}
	}
}
