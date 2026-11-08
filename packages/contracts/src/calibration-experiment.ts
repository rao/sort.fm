/** Batch 3 only. Batch 2's schemas and routes remain independent and unchanged. */
import {z} from 'zod';
import {CalibrationBatchEntrySchema,CalibrationBatchSelectionSchema,CalibrationBatchSkipSchema,CalibrationFrozenCandidateSchema} from './calibration-batch';
import {CalibrationQueueResultSchema} from './calibration';
import {FeatureVectorSchema} from './features';
import {CountSchema,IdempotencyKeySchema,SpotifyTrackIdSchema,TimestampSchema,UuidSchema} from './schemas';
import type {CalibrationLibraryRow} from './calibration-persistence';

export const CALIBRATION_BATCH3_EXPERIMENT='calibration-batch3-v1';
export const CalibrationExperimentIdSchema=z.literal(CALIBRATION_BATCH3_EXPERIMENT);
const ExperimentSchema=CalibrationExperimentIdSchema;
const DigestSchema=z.string().regex(/^[0-9a-f]{64}$/);
const TextSchema=z.string().min(1).refine(value=>value.trim().length>0,'Must contain non-whitespace text');
const SeedSchema=z.number().int().min(0).max(2147483647);
const target=(group:'A'|'B'|'C')=>group==='A'?40:group==='B'?20:0;
const unique=(values:readonly unknown[])=>new Set(values).size===values.length;
const problem=(ctx:z.RefinementCtx,message:string)=>ctx.addIssue({code:'custom',message});

/** Compact, sorted-object-key UTF-8 JSON input for SERVER-computed SHA-256.
 * Arrays retain their order. This is not Python's indented external artifact
 * encoding: hash those original bytes separately. Undefined/nonfinite/non-JSON
 * values fail closed. Do not trust a caller's digest instead of recomputing it.
 */
export function calibrationExperimentCanonical(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('Nonfinite canonical value');return JSON.stringify(value);}
 if(Array.isArray(value)){
  if(Object.keys(value).length!==value.length||Reflect.ownKeys(value).length!==value.length+1)throw new Error('Non-JSON canonical array');
  return '['+value.map(calibrationExperimentCanonical).join(',')+']';
 }
 if(typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)){
  if(Reflect.ownKeys(value).some(key=>typeof key!=='string'))throw new Error('Non-JSON canonical key');
  const object=value as Record<string,unknown>;
  return '{'+Object.keys(object).sort().map(key=>JSON.stringify(key)+':'+calibrationExperimentCanonical(object[key])).join(',')+'}';
 }
 throw new Error('Non-JSON canonical value');
}

/** Exact seed commitment byte input, committed privately BEFORE candidate read.
 * Persistence records the trusted operator artifact hash and chronology; caller
 * timestamps/hashes alone do not establish independent precommit evidence.
 */
export function calibrationExperimentSeedPrecommit(batchId:string,protocolVersion:string,seed:number):string {
 return JSON.stringify(['sortfm.batch3.seed.v1',UuidSchema.parse(batchId),TextSchema.parse(protocolVersion),SeedSchema.parse(seed)]);
}

export const CalibrationExperimentOwnerRevisionSchema=z.strictObject({feedbackRevision:CountSchema,membershipRevision:CountSchema});
export const CalibrationExperimentResearchBindingSchema=z.strictObject({protocolSha256:DigestSchema,trainingDataSha256:DigestSchema,modelSealSha256:DigestSchema});
/** Historical external evidence supplements live database checks; no outcomes. */
export const CalibrationExperimentExclusionLedgerSchema=z.strictObject({source:TextSchema,sortedTrackIds:z.array(SpotifyTrackIdSchema),sortedIdsSha256:DigestSchema}).superRefine((v,ctx)=>{
 if(v.sortedTrackIds.some((id,i)=>i>0&&id<=v.sortedTrackIds[i-1]!))problem(ctx,'Exclusion identities must be unique and lexically sorted');
});
export type CalibrationExperimentExclusionLedger=z.infer<typeof CalibrationExperimentExclusionLedgerSchema>;
export const CalibrationExperimentDigestsSchema=z.strictObject({snapshotSha256:DigestSchema,poolSha256:DigestSchema,rosterSha256:DigestSchema,eligibleTrackIdsSha256:DigestSchema});

const SelectionSchema=CalibrationBatchSelectionSchema.superRefine((s,ctx)=>{
 if(s.group==='C')problem(ctx,'Batch 3 has no C group');
});
const EntrySchema=CalibrationBatchEntrySchema.superRefine((e,ctx)=>{
 if(e.group==='C'||(e.group==='A'&&e.replacementFor!==null))problem(ctx,'Batch 3 permits replacements only in B');
});

/** Private immutable draft. Never accept from a browser or publish in a DTO.
 * candidates is the COMPLETE eligible pool sorted by trackId. Its frozen cards,
 * vectors, C1 predictions and listening context must never be rescored on replay.
 * A is selected first; replacementPool is the ordered complete complement of A,
 * including B's initial twenty. Only unused, still-eligible B members may replace.
 */
export const CalibrationExperimentDraftSchema=z.strictObject({
 batchId:UuidSchema,experiment:ExperimentSchema,protocolVersion:TextSchema,algorithmVersion:TextSchema,modelVersion:TextSchema,
 ownerRevision:CalibrationExperimentOwnerRevisionSchema,selectedAt:TimestampSchema,
 seedPrecommit:z.strictObject({seed:SeedSchema,commitment:DigestSchema,committedAt:TimestampSchema,artifactSha256:DigestSchema}),
 research:CalibrationExperimentResearchBindingSchema,exclusionLedger:CalibrationExperimentExclusionLedgerSchema,
 eligibleTrackIdsSha256:DigestSchema,candidates:z.array(CalibrationFrozenCandidateSchema).min(60).max(10000),
 selected:z.array(SelectionSchema).length(60),replacementPool:z.array(SelectionSchema).min(20).max(9960),
}).superRefine((d,ctx)=>{
 const ids=d.candidates.map(c=>c.track.trackId),poolIds=d.replacementPool.map(s=>s.trackId),aIds=d.selected.slice(0,40).map(s=>s.trackId);
 const candidates=new Set(ids),a=new Set(aIds),excluded=new Set(d.exclusionLedger.sortedTrackIds);
 if(ids.some((id,i)=>i>0&&id<=ids[i-1]!)||ids.some(id=>excluded.has(id)))problem(ctx,'Frozen pool must be sorted, unique and outside the strict exclusion ledger');
 if(d.candidates.some(c=>c.prediction.modelVersion!==d.modelVersion||c.prediction.featureVersion!==c.features.featureVersion||!c.features.permittedForTraining||c.track.source!=='spotify'||!c.track.isPlayable))problem(ctx,'Frozen candidates require playable Spotify cards and permitted features from one C1 model');
 if(Date.parse(d.seedPrecommit.committedAt)>Date.parse(d.selectedAt))problem(ctx,'Seed commitment must precede selection');
 if(!unique(d.selected.map(s=>s.trackId))||d.selected.some((s,i)=>!candidates.has(s.trackId)||s.group!==(i<40?'A':'B')||(i<40&&s.selectionProbability!==40/d.candidates.length)))problem(ctx,'Ordered roster must contain forty random A then twenty B from the frozen pool');
 if(!unique(poolIds)||poolIds.length!==ids.length-40||d.replacementPool.some(s=>s.group!=='B'||!candidates.has(s.trackId)||a.has(s.trackId)))problem(ctx,'B replacement pool must be the complete frozen complement of A');
 for(const s of d.selected.slice(40))if(!d.replacementPool.some(p=>calibrationExperimentCanonical(p)===calibrationExperimentCanonical(s)))problem(ctx,'Initial B selections must exactly match frozen B selection provenance');
 if(calibrationExperimentCanonical(d.selected.slice(40))!==calibrationExperimentCanonical(d.replacementPool.slice(0,20)))problem(ctx,'Initial B roster must follow the first twenty frozen replacement ranks');
});
export type CalibrationExperimentDraft=z.infer<typeof CalibrationExperimentDraftSchema>;

const ReservedGroupSchema=z.strictObject({group:z.enum(['A','B','C']),target:CountSchema,reserved:CountSchema});
const ReadyGroupSchema=z.strictObject({group:z.enum(['A','B','C']),target:CountSchema,labeled:CountSchema,pending:CountSchema,skipped:CountSchema,revoked:CountSchema});
const ReservedSchema=z.strictObject({batchId:UuidSchema,experiment:ExperimentSchema,phase:z.literal('reserved'),reservedAt:TimestampSchema,target:z.literal(60),groups:z.array(ReservedGroupSchema).length(3)}).superRefine((b,ctx)=>{
 if(!unique(b.groups.map(g=>g.group))||b.groups.some(g=>g.target!==target(g.group)||g.reserved!==target(g.group)))problem(ctx,'Reserved batch counts must be 40/20/0');
});
export const CalibrationExperimentReadySchema=z.strictObject({
 batchId:UuidSchema,experiment:ExperimentSchema,phase:z.literal('ready'),reservedAt:TimestampSchema,readyAt:TimestampSchema,
 algorithmVersion:TextSchema,modelVersion:TextSchema,candidateCount:CountSchema.min(60),target:z.literal(60),
 labeled:CountSchema,trainingLabeled:CountSchema,sealedLabeled:CountSchema,groups:z.array(ReadyGroupSchema).length(3),
 entries:z.array(EntrySchema).min(60),queue:CalibrationQueueResultSchema,
}).superRefine((b,ctx)=>{
 const bad=()=>problem(ctx,'Ready batch identities, groups, counts and frozen queue must agree');
 if(Date.parse(b.readyAt)<Date.parse(b.reservedAt)||!unique(b.entries.map(e=>e.trackId))||!unique(b.entries.map(e=>e.batchItemId))||!unique(b.entries.map(e=>e.exposureId))||!unique(b.groups.map(g=>g.group)))bad();
 if(b.entries.filter(e=>e.group==='A').length!==40||b.entries.filter(e=>e.group==='B'&&e.replacementFor===null).length!==20||b.entries.length>b.candidateCount)bad();
 for(const g of b.groups){const entries=b.entries.filter(e=>e.group===g.group);
  if(g.target!==target(g.group)||g.labeled!==entries.filter(e=>e.status==='labeled').length||g.pending!==entries.filter(e=>['pending','revoked'].includes(e.status)).length||g.skipped!==entries.filter(e=>e.status==='skipped').length||g.revoked!==entries.filter(e=>e.status==='revoked').length||g.labeled+g.pending>g.target)bad();
 }
 if(b.labeled!==b.entries.filter(e=>e.status==='labeled').length||b.sealedLabeled!==b.entries.filter(e=>e.status==='labeled'&&e.group==='A').length||b.trainingLabeled!==b.labeled-b.sealedLabeled||b.queue.remaining!==b.entries.filter(e=>['pending','revoked'].includes(e.status)).length)bad();
 for(const e of b.entries){
  if(e.group==='A'&&e.selectionProbability!==40/b.candidateCount)bad();
  if(e.replacementFor?Date.parse(e.selectedAt)<Date.parse(b.readyAt):Date.parse(e.selectedAt)>Date.parse(b.reservedAt))bad();
  if(e.replacementFor&&!b.entries.some(p=>p.batchItemId===e.replacementFor&&p.status==='skipped'&&p.group==='B'&&Date.parse(p.selectedAt)<=Date.parse(e.selectedAt)))bad();
 }
 if(!unique(b.entries.filter(e=>e.replacementFor).map(e=>e.replacementFor)))bad();
 // Timestamp ties and arbitrary projection order cannot establish ancestry.
 const byItem=new Map(b.entries.map(e=>[e.batchItemId,e]));
 const rooted=new Map(b.entries.filter(e=>e.group==='B'&&e.replacementFor===null).map(e=>[e.batchItemId,true]));
 for(const entry of b.entries.filter(e=>e.group==='B')){
  let cursor=entry;const path=new Set<string>();
  while(!rooted.has(cursor.batchItemId)){
   if(path.has(cursor.batchItemId)){rooted.set(cursor.batchItemId,false);break;}
   path.add(cursor.batchItemId);
   const parent=cursor.replacementFor?byItem.get(cursor.replacementFor):undefined;
   if(!parent||parent.group!=='B'){rooted.set(cursor.batchItemId,false);break;}
   cursor=parent;
  }
  const valid=rooted.get(cursor.batchItemId)===true;
  if(!valid)bad();for(const id of path)rooted.set(id,valid);
 }
 if(b.queue.items.some(i=>i.track.trackId!==i.exposure.trackId||i.prediction.modelVersion!==b.modelVersion||i.exposure.modelVersion!==b.modelVersion||!b.entries.some(e=>e.exposureId===i.exposure.exposureId&&e.trackId===i.track.trackId&&['pending','revoked'].includes(e.status))))bad();
});
export const CalibrationExperimentSchema=z.discriminatedUnion('phase',[ReservedSchema,CalibrationExperimentReadySchema]);
export const CalibrationExperimentReadSchema=z.strictObject({batch:CalibrationExperimentSchema.nullable()});
export const CalibrationExperimentSkipSchema=CalibrationBatchSkipSchema;
export type CalibrationExperimentSkip=z.infer<typeof CalibrationExperimentSkipSchema>;
export type CalibrationExperiment=z.infer<typeof CalibrationExperimentSchema>;
export type CalibrationExperimentReady=z.infer<typeof CalibrationExperimentReadySchema>;

/** Digest recipes: snapshot=canonical(validated full draft); pool=canonical(draft.candidates);
 * roster=canonical(draft.selected); eligible IDs=canonical(sorted complete candidate IDs).
 * Exclusion IDs use the same sorted-array recipe. D computes these, including the
 * seed tuple commitment, and rechecks owner revisions/current eligibility under lock.
 */
export const CalibrationExperimentReservationSchema=z.strictObject({batchId:UuidSchema,experiment:ExperimentSchema,reservedAt:TimestampSchema,ownerRevision:CalibrationExperimentOwnerRevisionSchema,digests:CalibrationExperimentDigestsSchema});
export type CalibrationExperimentReservation=z.infer<typeof CalibrationExperimentReservationSchema>;
export const CalibrationExperimentArtifactHashesSchema=z.strictObject({modelSealSha256:DigestSchema,candidatesSha256:DigestSchema,queryGroupsSha256:DigestSchema,ownerManifestSha256:DigestSchema,panelReviewSha256:DigestSchema,predictionsSha256:DigestSchema,queryAuditSha256:DigestSchema,predictionSealSha256:DigestSchema});
const EvaluationCandidateSchema=z.strictObject({trackId:SpotifyTrackIdSchema,features:FeatureVectorSchema});
/** PRIVATE verified-operator input, never an HTTP body. Root reads actual artifact
 * bytes and validates Research's schemas, byte digests, owner and trusted model.
 * D compares candidates/features/order and exact artist IDs to the stored A40,
 * recomputes all canonical digests and checks zero ever-feedback for all sixty.
 */
export const CalibrationExperimentSealInputSchema=z.strictObject({
 batchId:UuidSchema,idempotencyKey:IdempotencyKeySchema,expected:CalibrationExperimentDigestsSchema,
 research:CalibrationExperimentResearchBindingSchema,externalSealedAt:TimestampSchema,
 evaluationCandidates:z.array(EvaluationCandidateSchema).length(40),
 queryGroups:z.record(SpotifyTrackIdSchema,TextSchema.nullable()),artifacts:CalibrationExperimentArtifactHashesSchema,
}).superRefine((s,ctx)=>{
 const ids=s.evaluationCandidates.map(c=>c.trackId),keys=Object.keys(s.queryGroups);
 if(!unique(ids)||keys.length!==40||keys.some(id=>!ids.includes(id))||s.evaluationCandidates.some(c=>!c.features.permittedForTraining))problem(ctx,'Seal needs exactly forty unique label-free permitted candidates and matching primary artist keys');
 if(s.research.modelSealSha256!==s.artifacts.modelSealSha256)problem(ctx,'External model seal must match the frozen research binding');
});
export type CalibrationExperimentSealInput=z.infer<typeof CalibrationExperimentSealInputSchema>;
/** Immutable idempotency receipt. A replay returns this original receipt, even
 * after labeling has begun; changed canonical request content conflicts. All
 * timestamps are actual observations. No model fit, rescore, provider or reroll.
 */
export const CalibrationExperimentSealReceiptSchema=z.strictObject({
 batchId:UuidSchema,experiment:ExperimentSchema,idempotencyKey:IdempotencyKeySchema,requestFingerprint:DigestSchema,
 digests:CalibrationExperimentDigestsSchema,research:CalibrationExperimentResearchBindingSchema,artifacts:CalibrationExperimentArtifactHashesSchema,
 externalSealedAt:TimestampSchema,checkedAt:TimestampSchema,readyAt:TimestampSchema,everFeedbackCount:z.literal(0),
}).superRefine((s,ctx)=>{
 if(Date.parse(s.externalSealedAt)>Date.parse(s.checkedAt)||Date.parse(s.checkedAt)>=Date.parse(s.readyAt))problem(ctx,'External sealing and zero-event check must precede actual collection opening');
 if(s.research.modelSealSha256!==s.artifacts.modelSealSha256)problem(ctx,'Receipt model binding mismatch');
});
export type CalibrationExperimentSealReceipt=z.infer<typeof CalibrationExperimentSealReceiptSchema>;
export type CalibrationExperimentSnapshot={draft:CalibrationExperimentDraft;reservation:CalibrationExperimentReservation;seal:CalibrationExperimentSealReceipt|null};
export type CalibrationExperimentCandidateSnapshot={library:CalibrationLibraryRow[];eligibleTrackIds:string[];ownerRevision:z.infer<typeof CalibrationExperimentOwnerRevisionSchema>};

/** Operator-only candidates/reserve/snapshot/seal. Only read/skip are public.
 * All methods scope to the authenticated/operator owner; mutations share owner
 * lock and resolve idempotent replay before live checks. The candidate fence
 * excludes ANY historical feedback (including revoked/holdout), any calibration
 * exposure, every prior batch assignment/skip/replacement and known-track active
 * policy reservations or pending review/Undo. An adaptive draft with no selected
 * track does not reserve its entire pool. Unlabeled ordinary review exposures
 * are evidence only, not an additional exclusion. Existing labels/Undo reject
 * reserved batches in persistence; no preseal renewal or public artifact export.
 */
export interface CalibrationExperimentStore {
 calibrationExperimentCandidates(userId:string,exclusionLedger:CalibrationExperimentExclusionLedger):Promise<CalibrationExperimentCandidateSnapshot>;
 calibrationExperiment(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT,now:string):Promise<CalibrationExperiment|null>;
 /** Read-only: never renews exposures, scores candidates or queries providers. */
 calibrationExperimentSnapshot(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT):Promise<CalibrationExperimentSnapshot|null>;
 reserveCalibrationExperiment(userId:string,draft:CalibrationExperimentDraft):Promise<CalibrationExperimentReservation>;
 sealCalibrationExperiment(userId:string,input:CalibrationExperimentSealInput):Promise<CalibrationExperimentSealReceipt>;
 skipCalibrationExperiment(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT,input:z.infer<typeof CalibrationExperimentSkipSchema>,now:string):Promise<CalibrationExperimentReady>;
}
