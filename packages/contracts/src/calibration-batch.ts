import {z} from 'zod';
import {CountSchema,IdempotencyKeySchema,PredictionSchema,ProbabilitySchema,SpotifyTrackIdSchema,TimestampSchema,TrackCardSchema,UuidSchema} from './schemas';
import {FeatureVectorSchema} from './features';
import {CalibrationQueueResultSchema} from './calibration';
import type {CalibrationCandidateSnapshot} from './calibration-persistence';
export const CALIBRATION_BATCH_EXPERIMENT='calibration-batch2-v1';
export const CalibrationBatchCreateSchema=z.strictObject({seed:z.number().int().min(0).max(2147483647).default(42)});
export const CalibrationBatchSkipSchema=z.strictObject({exposureId:UuidSchema,idempotencyKey:IdempotencyKeySchema});
export const CalibrationBatchSelectionSchema=z.strictObject({
 trackId:SpotifyTrackIdSchema,group:z.enum(['A','B','C']),assignment:z.enum(['sealed_evaluation','train']),
 samplingMethod:z.string().min(1),selectionScore:z.number().finite().nullable(),
 scoreKind:z.enum(['seeded_random','coverage_distance','entropy_heuristic','calibrated_entropy']),
 // Initial A: marginal inclusion probability 25/N; replacements: conditional draw
 // probability 1/N_remaining. B/C are deterministic heuristics, hence null.
 selectionProbability:ProbabilitySchema.nullable(),
}).superRefine((s,ctx)=>{
 if((s.group==='A')!==(s.assignment==='sealed_evaluation') || (s.group==='A' ? s.scoreKind!=='seeded_random'||s.selectionScore!==null||s.selectionProbability===null : s.selectionProbability!==null) || (s.group==='B'&&s.scoreKind!=='coverage_distance') || (s.group==='C'&&!['entropy_heuristic','calibrated_entropy'].includes(s.scoreKind)))ctx.addIssue({code:'custom',message:'Sampling group, assignment and score provenance must agree'});
});
export const CalibrationBatchEntrySchema=CalibrationBatchSelectionSchema.safeExtend({
 batchItemId:UuidSchema,exposureId:UuidSchema,selectedAt:TimestampSchema,
 status:z.enum(['pending','labeled','skipped','revoked']),replacementFor:UuidSchema.nullable(),
});
export const CalibrationBatchSchema=z.strictObject({
 batchId:UuidSchema,experiment:z.literal(CALIBRATION_BATCH_EXPERIMENT),seed:CalibrationBatchCreateSchema.shape.seed,
 algorithmVersion:z.string().min(1),modelVersion:z.string().min(1),selectedAt:TimestampSchema,
 candidateCount:CountSchema,target:z.literal(70),labeled:CountSchema,trainingLabeled:CountSchema,sealedLabeled:CountSchema,
 groups:z.array(z.strictObject({group:z.enum(['A','B','C']),target:CountSchema,labeled:CountSchema,pending:CountSchema,skipped:CountSchema,revoked:CountSchema})).length(3),
 entries:z.array(CalibrationBatchEntrySchema),queue:CalibrationQueueResultSchema,
}).superRefine((b,ctx)=>{
 const bad=()=>ctx.addIssue({code:'custom',message:'Batch identities, target counts and saved outcomes must agree'});
 if(new Set(b.entries.map(e=>e.trackId)).size!==b.entries.length||new Set(b.entries.map(e=>e.batchItemId)).size!==b.entries.length||new Set(b.entries.map(e=>e.exposureId)).size!==b.entries.length||new Set(b.groups.map(g=>g.group)).size!==3)bad();
 for(const g of b.groups){const entries=b.entries.filter(e=>e.group===g.group);
  if(g.target!==(g.group==='C'?20:25)||g.labeled!==entries.filter(e=>e.status==='labeled').length||g.pending!==entries.filter(e=>['pending','revoked'].includes(e.status)).length||g.skipped!==entries.filter(e=>e.status==='skipped').length||g.revoked!==entries.filter(e=>e.status==='revoked').length||g.labeled+g.pending>g.target)bad();
 }
 if(b.labeled!==b.entries.filter(e=>e.status==='labeled').length||b.sealedLabeled!==b.entries.filter(e=>e.status==='labeled'&&e.assignment==='sealed_evaluation').length||b.trainingLabeled!==b.labeled-b.sealedLabeled||b.queue.remaining!==b.entries.filter(e=>['pending','revoked'].includes(e.status)).length)bad();
 if(b.queue.items.some(i=>!b.entries.some(e=>e.exposureId===i.exposure.exposureId&&e.trackId===i.track.trackId&&['pending','revoked'].includes(e.status))))bad();
 for(const e of b.entries)if(e.replacementFor&&!b.entries.some(p=>p.batchItemId===e.replacementFor&&p.status==='skipped'&&p.group===e.group))bad();
 if(new Set(b.entries.filter(e=>e.replacementFor).map(e=>e.replacementFor)).size!==b.entries.filter(e=>e.replacementFor).length)bad();
});
export const CalibrationBatchReadSchema=z.strictObject({batch:CalibrationBatchSchema.nullable()});
export type CalibrationBatch=z.infer<typeof CalibrationBatchSchema>;
export type CalibrationBatchSelection=z.infer<typeof CalibrationBatchSelectionSchema>;
export type CalibrationBatchSkip=z.infer<typeof CalibrationBatchSkipSchema>;
export const CalibrationFrozenCandidateSchema=z.strictObject({track:TrackCardSchema,features:FeatureVectorSchema,prediction:PredictionSchema});
/** Private server-side snapshot; never exposed as a training/evaluation export. */
export const CalibrationBatchDraftSchema=z.strictObject({
 batchId:UuidSchema,seed:CalibrationBatchCreateSchema.shape.seed,algorithmVersion:z.string().min(1),modelVersion:z.string().min(1),selectedAt:TimestampSchema,
 candidates:z.array(CalibrationFrozenCandidateSchema).min(70).max(10000),
 selected:z.array(CalibrationBatchSelectionSchema).length(70),
 pools:z.strictObject({A:z.array(CalibrationBatchSelectionSchema),B:z.array(CalibrationBatchSelectionSchema),C:z.array(CalibrationBatchSelectionSchema)}),
}).superRefine((d,ctx)=>{
 const bad=()=>ctx.addIssue({code:'custom',message:'A batch must freeze unique candidates, one model and exactly 25/25/20 selections'});
 const ids=new Set(d.candidates.map(c=>c.track.trackId));
 if(ids.size!==d.candidates.length||new Set(d.selected.map(s=>s.trackId)).size!==70||d.candidates.some(c=>c.prediction.modelVersion!==d.modelVersion))bad();
 for(const group of ['A','B','C'] as const){
  if(d.selected.filter(s=>s.group===group).length!==(group==='C'?20:25)||new Set(d.pools[group].map(s=>s.trackId)).size!==d.pools[group].length||d.pools[group].some(s=>s.group!==group||!ids.has(s.trackId)))bad();
  for(const s of d.selected.filter(s=>s.group===group))if(!d.pools[group].some(p=>JSON.stringify(p)===JSON.stringify(s)))bad();
 }
});
export type CalibrationBatchDraft=z.infer<typeof CalibrationBatchDraftSchema>;
export interface CalibrationBatchStore {
 calibrationBatchCandidates(userId:string):Promise<CalibrationCandidateSnapshot>;
 calibrationBatch(userId:string,now:string):Promise<CalibrationBatch|null>;
 createCalibrationBatch(userId:string,draft:CalibrationBatchDraft):Promise<CalibrationBatch>;
 skipCalibrationBatch(userId:string,input:CalibrationBatchSkip,now:string):Promise<CalibrationBatch>;
}
