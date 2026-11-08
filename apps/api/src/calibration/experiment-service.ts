import {createHash} from 'node:crypto';
import {
 CalibrationExperimentDraftSchema,CalibrationExperimentIdSchema,CalibrationExperimentOwnerRevisionSchema,
 CalibrationExperimentReservationSchema,CalibrationExperimentSchema,CalibrationExperimentReadySchema,
 CalibrationExperimentSealInputSchema,CalibrationExperimentSealReceiptSchema,CalibrationExperimentSkipSchema,
 CalibrationFrozenCandidateSchema,FeatureVectorSchema,IdSchema,ListeningContextSnapshotSchema,ScoreResponseSchema,
 calibrationExperimentCanonical,calibrationExperimentSeedPrecommit,
 type CalibrationExperimentDraft,type CalibrationExperimentStore,type CalibrationExperimentSnapshot,
 type CalibrationExperimentSealInput,type CalibrationExperimentSkip,type CALIBRATION_BATCH3_EXPERIMENT,
} from '@sortfm/contracts';
import {z} from 'zod';
import {assembleLibraryCandidates} from '../ml/features';
import type {CalibrationBatchOptions} from './batch-service';
import {CalibrationError,invalidResponse} from './errors';
import {EXPERIMENT_ALGORITHM,selectCalibrationExperiment} from './experiment-selection';

/** Trusted operator input only. No public route accepts this shape. */
const shape=CalibrationExperimentDraftSchema.shape;
export const CalibrationExperimentReserveInputSchema=z.strictObject({
 batchId:shape.batchId,experiment:shape.experiment,protocolVersion:shape.protocolVersion,seedPrecommit:shape.seedPrecommit,research:shape.research,exclusionLedger:shape.exclusionLedger,
});
export type CalibrationExperimentReserveInput=z.infer<typeof CalibrationExperimentReserveInputSchema>;
export type CalibrationExperimentOptions=CalibrationBatchOptions;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>sha(calibrationExperimentCanonical(value));
const same=(a:unknown,b:unknown)=>calibrationExperimentCanonical(a)===calibrationExperimentCanonical(b);
const operatorFields=(draft:CalibrationExperimentDraft)=>CalibrationExperimentReserveInputSchema.parse(Object.fromEntries(Object.keys(CalibrationExperimentReserveInputSchema.shape).map(key=>[key,draft[key as keyof CalibrationExperimentDraft]])));
const badSnapshot=()=>new CalibrationError('BATCH_INVALID_SNAPSHOT','The experiment candidate snapshot could not be verified.',503,true);
function digests(draft:CalibrationExperimentDraft){return {snapshotSha256:digest(draft),poolSha256:digest(draft.candidates),rosterSha256:digest(draft.selected),eligibleTrackIdsSha256:digest(draft.candidates.map(c=>c.track.trackId))};}
function validateSnapshot(value:CalibrationExperimentSnapshot):CalibrationExperimentSnapshot {
 try{
  const draft=CalibrationExperimentDraftSchema.parse(value.draft),reservation=CalibrationExperimentReservationSchema.parse(value.reservation),seal=value.seal===null?null:CalibrationExperimentSealReceiptSchema.parse(value.seal);
  if(reservation.batchId!==draft.batchId||reservation.experiment!==draft.experiment||!same(reservation.ownerRevision,draft.ownerRevision)||!same(reservation.digests,digests(draft))||draft.eligibleTrackIdsSha256!==reservation.digests.eligibleTrackIdsSha256
   ||(seal&&(seal.batchId!==draft.batchId||!same(seal.digests,reservation.digests)||!same(seal.research,draft.research))))throw Error('snapshot identity');
  return {draft,reservation,seal};
 }catch{throw invalidResponse();}
}

/** Private reserve/snapshot/seal orchestration; only read/skip enter the browser module. */
export class CalibrationExperimentService {
 constructor(private readonly store:CalibrationExperimentStore,private readonly options:CalibrationExperimentOptions={}){
  const timeout=options.scoreTimeoutMs??30000;
  if(!Number.isInteger(timeout)||timeout<=0||timeout>2_147_483_647)throw RangeError('Invalid experiment scoring timeout');
 }
 private now(){return new Date((this.options.now??Date.now)()).toISOString();}
 async read(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT){
  IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);
  const value=await this.store.calibrationExperiment(userId,experiment,this.now());
  if(value===null)return null;const parsed=CalibrationExperimentSchema.safeParse(value);if(!parsed.success)throw invalidResponse();return parsed.data;
 }
 async snapshot(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT){
  IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);
  const value=await this.store.calibrationExperimentSnapshot(userId,experiment);return value===null?null:validateSnapshot(value);
 }
 async reserve(userId:string,value:CalibrationExperimentReserveInput){
  IdSchema.parse(userId);const input=CalibrationExperimentReserveInputSchema.parse(value);
  if(input.seedPrecommit.commitment!==sha(calibrationExperimentSeedPrecommit(input.batchId,input.protocolVersion,input.seedPrecommit.seed))
   ||input.exclusionLedger.sortedIdsSha256!==digest(input.exclusionLedger.sortedTrackIds))throw new CalibrationError('BATCH_COMMITMENT_INVALID','The private experiment commitment could not be verified.',409);
  // Identical replay keeps the original receipt even after time, membership or labels change.
  const existing=await this.snapshot(userId,input.experiment);
  if(existing){if(!same(operatorFields(existing.draft),input))throw new CalibrationError('IDEMPOTENCY_CONFLICT','This experiment already has a different saved reservation.',409);return existing.reservation;}
  const selectedAt=this.now();
  if(Date.parse(input.seedPrecommit.committedAt)>Date.parse(selectedAt))throw new CalibrationError('BATCH_COMMITMENT_INVALID','The private seed commitment must precede candidate capture.',409);
  const snapshot=await this.store.calibrationExperimentCandidates(userId,structuredClone(input.exclusionLedger));
  const ownerRevision=CalibrationExperimentOwnerRevisionSchema.parse(snapshot.ownerRevision),byId=new Map(snapshot.library.map(r=>[r.track.trackId,r])),eligible=new Set(snapshot.eligibleTrackIds),excluded=new Set(input.exclusionLedger.sortedTrackIds);
  if(byId.size!==snapshot.library.length||eligible.size!==snapshot.eligibleTrackIds.length||[...eligible].some(id=>{
   const row=byId.get(id);return !row||excluded.has(id)||row.track.source!=='spotify'||!row.track.isPlayable||!['saved','deferred'].includes(row.currentStatus)||row.currentDecision!==null;
  }))throw badSnapshot();
  if(eligible.size<60)throw new CalibrationError('BATCH_INSUFFICIENT_CANDIDATES','Batch 3 needs at least sixty strictly eligible songs.',409);
  if(eligible.size>10000)throw new CalibrationError('BATCH_POOL_TOO_LARGE','The full experiment pool exceeds the scoring limit.',409);
  const context={userId,now:Date.parse(selectedAt)};
  const loaded=this.options.load?await this.options.load(structuredClone(snapshot.library),context):{candidates:this.options.assemble?this.options.assemble(structuredClone(snapshot.library),context):assembleLibraryCandidates(snapshot.library,{userId,now:selectedAt})};
  const assembled=loaded.candidates,listeningContext=loaded.listeningContext===undefined?undefined:ListeningContextSnapshotSchema.parse(loaded.listeningContext);
  if(assembled.length!==byId.size||new Set(assembled.map(c=>c.trackId)).size!==byId.size||assembled.some(c=>!byId.has(c.trackId)))throw badSnapshot();
  const candidates=assembled.filter(c=>eligible.has(c.trackId)).map(c=>({trackId:c.trackId,features:FeatureVectorSchema.parse(c.features)})).sort((a,b)=>a.trackId<b.trackId?-1:a.trackId>b.trackId?1:0);
  if(candidates.some(c=>!c.features.permittedForTraining))throw new CalibrationError('BATCH_FEATURE_PERMISSION_REQUIRED','Every experiment candidate requires an explicit training permission.',409);
  // Detach metadata before scoring as well: external adapters cannot change the reserved pool.
  const cards=new Map([...eligible].map(id=>[id,structuredClone(byId.get(id)!.track)]));
  let response:ReturnType<typeof ScoreResponseSchema.parse>,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=performance.now()+(this.options.scoreTimeoutMs??30000);
  try{
   if(!this.options.score)throw Error('missing scorer');
   response=ScoreResponseSchema.parse(await Promise.race([this.options.score(userId,structuredClone(candidates),null),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),Math.max(1,deadline-performance.now()));})]));
   const first=response.predictions[0]?.prediction;
   if(performance.now()>deadline||response.userId!==userId||!response.modelVersion||response.predictions.length!==candidates.length||new Set(response.predictions.map(p=>p.trackId)).size!==candidates.length
    ||response.predictions.some(p=>!eligible.has(p.trackId)||p.prediction.modelVersion!==response.modelVersion||!['logistic','sgd_logistic'].includes(p.prediction.modelKind)||p.prediction.removalProbability===null||p.prediction.trainedExamples<=0||p.prediction.modelKind!==first?.modelKind||p.prediction.trainedExamples!==first?.trainedExamples))throw Error('incoherent scoring');
  }catch{throw new CalibrationError('BATCH_SCORING_UNAVAILABLE','Batch 3 requires a complete trained C1 probability snapshot. No panel was reserved.',503,true);}finally{clearTimeout(timer);}
  const scores=new Map(response.predictions.map(p=>[p.trackId,p.prediction]));
  const frozen=candidates.map(c=>CalibrationFrozenCandidateSchema.parse({track:cards.get(c.trackId),features:c.features,prediction:scores.get(c.trackId),...(listeningContext?{listeningContext}: {})}));
  const selection=selectCalibrationExperiment(frozen,input.seedPrecommit.seed);
  const draft=CalibrationExperimentDraftSchema.parse({...input,selectedAt,ownerRevision,algorithmVersion:EXPERIMENT_ALGORITHM,modelVersion:response.modelVersion,eligibleTrackIdsSha256:digest(candidates.map(c=>c.trackId)),candidates:frozen,...selection});
  const expected=digests(draft);
  let receipt:unknown;
  try{receipt=await this.store.reserveCalibrationExperiment(userId,structuredClone(draft));}
  catch(error){
   // Two operators may both have observed no saved batch. D preserves the first
   // exact draft. Resolve only this known conflict against its authoritative copy.
   if(error&&typeof error==='object'&&'code'in error&&error.code==='IDEMPOTENCY_CONFLICT'){
    const saved=await this.snapshot(userId,input.experiment);
    if(saved&&same(operatorFields(saved.draft),input))return saved.reservation;
   }
   throw error;
  }
  const result=CalibrationExperimentReservationSchema.safeParse(receipt);
  if(!result.success||result.data.batchId!==draft.batchId||!same(result.data.ownerRevision,ownerRevision)||!same(result.data.digests,expected))throw invalidResponse();
  return result.data;
 }
 async seal(userId:string,input:CalibrationExperimentSealInput){
  IdSchema.parse(userId);const value=CalibrationExperimentSealInputSchema.parse(input);
  // Root verifies actual private artifact bytes before invoking this operator-only method.
  const result=CalibrationExperimentSealReceiptSchema.safeParse(await this.store.sealCalibrationExperiment(userId,structuredClone(value)));
  if(!result.success||result.data.batchId!==value.batchId||result.data.idempotencyKey!==value.idempotencyKey||result.data.requestFingerprint!==digest(value)||!same(result.data.digests,value.expected)||!same(result.data.research,value.research)||!same(result.data.artifacts,value.artifacts)||result.data.externalSealedAt!==value.externalSealedAt)throw invalidResponse();
  return result.data;
 }
 async skip(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT,input:CalibrationExperimentSkip){
  IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);const request=CalibrationExperimentSkipSchema.parse(input);
  const result=CalibrationExperimentReadySchema.safeParse(await this.store.skipCalibrationExperiment(userId,experiment,request,this.now()));if(!result.success)throw invalidResponse();return result.data;
 }
}
