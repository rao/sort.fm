import {expect, test} from 'bun:test';
import {
  CALIBRATION_BATCH3_EXPERIMENT, CalibrationExperimentDraftSchema,
  CalibrationExperimentExclusionLedgerSchema, CalibrationExperimentSchema,
  CalibrationExperimentSealInputSchema, CalibrationExperimentSealReceiptSchema,
  calibrationExperimentCanonical, calibrationExperimentSeedPrecommit,
} from '../src/calibration-experiment';
import {CalibrationBatchDraftSchema} from '../src/calibration-batch';
import {selectCalibrationBatch} from '../../../apps/api/src/calibration/batch-selection';
import {row, prediction} from '../../../apps/api/src/calibration/test-fixtures';
import {CONTRACT_VERSION, FEATURE_VERSION,QueueItemSchema} from '../src/schemas';
type QueueItem=ReturnType<typeof QueueItemSchema.parse>;

const hash='a'.repeat(64), batchId='10000000-0000-4000-8000-000000000001';
const at='2026-11-08T02:00:00.000Z', later='2026-11-08T02:01:00.000Z';
const research={protocolSha256:hash,trainingDataSha256:hash,modelSealSha256:hash};
const digests={snapshotSha256:hash,poolSha256:hash,rosterSha256:hash,eligibleTrackIdsSha256:hash};
const candidates=Array.from({length:80},(_,i)=>({track:row(i+1).track,prediction,features:{featureVersion:FEATURE_VERSION,provenance:'synthetic' as const,permittedForTraining:true,values:{saved_age_days:i}}}));
const selection=(i:number,group:'A'|'B')=>({trackId:candidates[i]!.track.trackId,group,assignment:group==='A'?'sealed_evaluation' as const:'train' as const,samplingMethod:group==='A'?'seeded_uniform':'coverage_distance',selectionScore:group==='A'?null:i,scoreKind:group==='A'?'seeded_random' as const:'coverage_distance' as const,selectionProbability:group==='A'?40/candidates.length:null});
function draft(){return {batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,protocolVersion:'batch3:v1',algorithmVersion:'batch3:random40-diverse20:v1',modelVersion:prediction.modelVersion,ownerRevision:{feedbackRevision:228,membershipRevision:3},selectedAt:at,seedPrecommit:{seed:42,commitment:hash,committedAt:'2026-11-08T01:59:00.000Z',artifactSha256:hash},research,exclusionLedger:{source:'synthetic test ledger',sortedTrackIds:[],sortedIdsSha256:hash},eligibleTrackIdsSha256:hash,candidates:structuredClone(candidates),selected:[...Array.from({length:40},(_,i)=>selection(i,'A')),...Array.from({length:20},(_,i)=>selection(i+40,'B'))],replacementPool:Array.from({length:40},(_,i)=>selection(i+40,'B'))};}
const reservedGroups=()=>['A','B','C'].map((group,i)=>({group,target:[40,20,0][i]!,reserved:[40,20,0][i]!}));
const readyGroups=()=>['A','B','C'].map((group,i)=>({group,target:[40,20,0][i]!,labeled:0,pending:[40,20,0][i]!,skipped:0,revoked:0}));
function reserved(){return {batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,phase:'reserved',reservedAt:at,target:60,groups:reservedGroups()};}
function ready(){return {batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,phase:'ready',reservedAt:at,readyAt:later,algorithmVersion:draft().algorithmVersion,modelVersion:prediction.modelVersion,candidateCount:80,target:60,labeled:0,trainingLabeled:0,sealedLabeled:0,groups:readyGroups(),entries:draft().selected.map(s=>({...s,batchItemId:crypto.randomUUID(),exposureId:crypto.randomUUID(),selectedAt:at,status:'pending',replacementFor:null as string|null})),queue:{contractVersion:CONTRACT_VERSION,mode:'calibration',items:[] as QueueItem[],remaining:60,nextCursor:null,fallbackReason:null}};}
function seal(){return {batchId,idempotencyKey:crypto.randomUUID(),expected:digests,research,externalSealedAt:later,evaluationCandidates:candidates.slice(0,40).map(c=>({trackId:c.track.trackId,features:c.features})),queryGroups:Object.fromEntries(candidates.slice(0,40).map(c=>[c.track.trackId,c.track.artists[0]?.id??null])),artifacts:{modelSealSha256:hash,candidatesSha256:hash,queryGroupsSha256:hash,ownerManifestSha256:hash,panelReviewSha256:hash,predictionsSha256:hash,queryAuditSha256:hash,predictionSealSha256:hash}};}

test('Batch3 freezes exactly forty random A, twenty diverse B and every remaining B candidate',()=>{
 expect(CalibrationExperimentDraftSchema.safeParse(draft()).success).toBe(true);
 const alterations:Array<(d:ReturnType<typeof draft>)=>unknown>=[d=>d.selected.reverse(),d=>d.selected.pop(),d=>d.selected[0]=d.selected[1]!,d=>d.selected[0]!.selectionProbability=.01,d=>d.replacementPool.pop(),d=>d.replacementPool.push(selection(0,'B'))];
 for(const alter of alterations){const d=draft();alter(d);expect(CalibrationExperimentDraftSchema.safeParse(d).success).toBe(false);}
});
test('frozen snapshots reject mixed identities, model revisions and unusable feature provenance',()=>{
 const alterations:Array<(d:ReturnType<typeof draft>)=>unknown>=[d=>d.candidates[1]=d.candidates[0]!,d=>d.candidates[0]!.prediction={...prediction,modelVersion:'other'},d=>d.candidates[0]!.features.permittedForTraining=false,d=>d.candidates[0]!.track={...d.candidates[0]!.track,isPlayable:false},d=>d.selected[40]!.selectionScore=999];
 for(const alter of alterations){const d=draft();alter(d);expect(CalibrationExperimentDraftSchema.safeParse(d).success).toBe(false);}
 expect(CalibrationExperimentDraftSchema.safeParse({...draft(),research:{...research,modelSealSha256:'bad'}}).success).toBe(false);
});
test('strict exclusion ledger is sorted, unique and disjoint from the complete frozen pool',()=>{
 const ids=candidates.slice(0,2).map(c=>c.track.trackId);
 for(const sortedTrackIds of [[ids[1],ids[0]],[ids[0],ids[0]]])expect(CalibrationExperimentExclusionLedgerSchema.safeParse({source:'test',sortedTrackIds,sortedIdsSha256:hash}).success).toBe(false);
 expect(CalibrationExperimentDraftSchema.safeParse({...draft(),exclusionLedger:{source:'test',sortedTrackIds:[ids[0]],sortedIdsSha256:hash}}).success).toBe(false);
});
test('seed precommit precedes selection and cannot use a floating point seed',()=>{
 const d=draft();expect(CalibrationExperimentDraftSchema.safeParse({...d,seedPrecommit:{...d.seedPrecommit,committedAt:later}}).success).toBe(false);
 expect(CalibrationExperimentDraftSchema.safeParse({...d,seedPrecommit:{...d.seedPrecommit,seed:4.2}}).success).toBe(false);
 expect(calibrationExperimentSeedPrecommit(batchId,'batch3:v1',42)).toBe(JSON.stringify(['sortfm.batch3.seed.v1',batchId,'batch3:v1',42]));
 expect(()=>calibrationExperimentSeedPrecommit(batchId,'batch3:v1',4.2)).toThrow();
});
test('reserved projection has only fixed counts and rejects any card, identity or private evidence leak',()=>{
 expect(CalibrationExperimentSchema.safeParse(reserved()).success).toBe(true);
 for(const extra of [{entries:[]},{queue:{items:[]}},{exposureId:crypto.randomUUID()},{candidates:[]},{seed:42},{research}])expect(CalibrationExperimentSchema.safeParse({...reserved(),...extra}).success).toBe(false);
 const r=reserved();r.groups[0]!.reserved=39;expect(CalibrationExperimentSchema.safeParse(r).success).toBe(false);
});
test('ready projection retains exact group counts, unique identities and same-model queue provenance',()=>{
 expect(CalibrationExperimentSchema.safeParse(ready()).success).toBe(true);
 const r=ready();r.groups[2]!.target=20;expect(CalibrationExperimentSchema.safeParse(r).success).toBe(false);
 const duplicates=ready();duplicates.entries[1]!.exposureId=duplicates.entries[0]!.exposureId;expect(CalibrationExperimentSchema.safeParse(duplicates).success).toBe(false);
 expect(CalibrationExperimentSchema.safeParse({...ready(),readyAt:'2026-11-08T01:00:00.000Z'}).success).toBe(false);
 const wrong=ready();wrong.entries[0]!.group='B';expect(CalibrationExperimentSchema.safeParse(wrong).success).toBe(false);
 const queued=ready();const entry=queued.entries[0]!;
 queued.queue.items.push({track:candidates[0]!.track,prediction,exposure:{exposureId:entry.exposureId,trackId:entry.trackId,policy:'balanced',selectionMethod:'deterministic_baseline',policyVersion:'batch3:v1',explorationCoefficient:0,propensityEstimate:null,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,removalScore:prediction.removalProbability,heuristicScore:prediction.heuristicScore,uncertainty:prediction.uncertainty,position:0,servedAt:at}});
 expect(CalibrationExperimentSchema.safeParse(queued).success).toBe(true);
 queued.queue.items[0]!.prediction={...prediction,modelVersion:'wrong'};queued.queue.items[0]!.exposure.modelVersion='wrong';
 expect(CalibrationExperimentSchema.safeParse(queued).success).toBe(false);
});
test('A skips never permit replacements; B replacement points to one skipped B parent',()=>{
 const a=ready();a.entries[0]!.status='skipped';a.groups[0]!.pending=39;a.groups[0]!.skipped=1;a.queue.remaining=59;
 expect(CalibrationExperimentSchema.safeParse(a).success).toBe(true);
 a.entries.push({...a.entries[0]!,trackId:candidates[60]!.track.trackId,batchItemId:crypto.randomUUID(),exposureId:crypto.randomUUID(),status:'pending',replacementFor:a.entries[0]!.batchItemId});a.groups[0]!.pending=40;a.queue.remaining=60;
 expect(CalibrationExperimentSchema.safeParse(a).success).toBe(false);
 const b=ready();b.entries[40]!.status='skipped';b.groups[1]!.skipped=1;
 b.entries.push({...selection(60,'B'),batchItemId:crypto.randomUUID(),exposureId:crypto.randomUUID(),selectedAt:later,status:'pending',replacementFor:b.entries[40]!.batchItemId});
 expect(CalibrationExperimentSchema.safeParse(b).success).toBe(true);
 b.entries[60]!.replacementFor=b.entries[0]!.batchItemId;expect(CalibrationExperimentSchema.safeParse(b).success).toBe(false);
});
test('ready A entries retain the original forty-over-complete-pool inclusion probability',()=>{
 const r=ready();expect(CalibrationExperimentSchema.safeParse(r).success).toBe(true);
 r.entries[0]!.selectionProbability=.01;
 expect(CalibrationExperimentSchema.safeParse(r).success).toBe(false);
 const changedPool=ready();changedPool.candidateCount=100;
 expect(CalibrationExperimentSchema.safeParse(changedPool).success).toBe(false);
});
test('B replacement ancestry rejects a skipped self-cycle',()=>{
 const self=ready(),selfId=crypto.randomUUID();
 self.entries.push({...selection(60,'B'),batchItemId:selfId,exposureId:crypto.randomUUID(),selectedAt:later,status:'skipped',replacementFor:selfId});
 self.groups[1]!.skipped=1;
 expect(CalibrationExperimentSchema.safeParse(self).success).toBe(false);
});
test('B replacement ancestry rejects a disconnected two-item cycle at equal timestamps',()=>{
 const pair=ready(),leftId=crypto.randomUUID(),rightId=crypto.randomUUID();
 pair.entries.push(
  {...selection(60,'B'),batchItemId:leftId,exposureId:crypto.randomUUID(),selectedAt:later,status:'skipped',replacementFor:rightId},
  {...selection(61,'B'),batchItemId:rightId,exposureId:crypto.randomUUID(),selectedAt:later,status:'skipped',replacementFor:leftId},
 );
 pair.groups[1]!.skipped=2;
 expect(CalibrationExperimentSchema.safeParse(pair).success).toBe(false);
});
test('valid B replacement ancestry is independent of entry order and permits equal timestamps',()=>{
 const r=ready(),firstId=crypto.randomUUID();
 r.entries[40]!.status='skipped';r.groups[1]!.skipped=2;
 r.entries.unshift(
  {...selection(61,'B'),batchItemId:crypto.randomUUID(),exposureId:crypto.randomUUID(),selectedAt:later,status:'pending',replacementFor:firstId},
  {...selection(60,'B'),batchItemId:firstId,exposureId:crypto.randomUUID(),selectedAt:later,status:'skipped',replacementFor:r.entries[40]!.batchItemId},
 );
 expect(CalibrationExperimentSchema.safeParse(r).success).toBe(true);
});
test('seal request binds forty label-free features, exact artist keys and all external artifact digests',()=>{
 expect(CalibrationExperimentSealInputSchema.safeParse(seal()).success).toBe(true);
 const s=seal();s.evaluationCandidates[0]!.trackId=s.evaluationCandidates[1]!.trackId;expect(CalibrationExperimentSealInputSchema.safeParse(s).success).toBe(false);
 expect(CalibrationExperimentSealInputSchema.safeParse({...seal(),queryGroups:{}}).success).toBe(false);
 const extra=seal();extra.queryGroups[candidates[40]!.track.trackId]='artist';expect(CalibrationExperimentSealInputSchema.safeParse(extra).success).toBe(false);
 expect(CalibrationExperimentSealInputSchema.safeParse({...seal(),evaluationCandidates:seal().evaluationCandidates.map(c=>({...c,label:1}))}).success).toBe(false);
 const mismatch=seal();mismatch.artifacts.modelSealSha256='b'.repeat(64);expect(CalibrationExperimentSealInputSchema.safeParse(mismatch).success).toBe(false);
 expect(CalibrationExperimentSealInputSchema.safeParse({...seal(),idempotencyKey:'bad'}).success).toBe(false);
});
test('immutable seal receipt requires zero events and actual postseal check before collection opens',()=>{
 const s=seal();const receipt={batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,idempotencyKey:s.idempotencyKey,requestFingerprint:hash,digests,research,artifacts:s.artifacts,externalSealedAt:later,checkedAt:'2026-11-08T02:01:01.000Z',readyAt:'2026-11-08T02:01:02.000Z',everFeedbackCount:0};
 expect(CalibrationExperimentSealReceiptSchema.safeParse(receipt).success).toBe(true);
 for(const extra of [{everFeedbackCount:1},{checkedAt:at},{readyAt:receipt.checkedAt},{requestFingerprint:hash.toUpperCase()}])expect(CalibrationExperimentSealReceiptSchema.safeParse({...receipt,...extra}).success).toBe(false);
});
test('canonical digest input is stable by object key and preserves array/roster order',()=>{
 expect(calibrationExperimentCanonical({b:[2,1],a:{z:null,c:1}})).toBe('{"a":{"c":1,"z":null},"b":[2,1]}');
 expect(calibrationExperimentCanonical({a:1,b:2})).toBe(calibrationExperimentCanonical({b:2,a:1}));
 expect(calibrationExperimentCanonical([1,2])).not.toBe(calibrationExperimentCanonical([2,1]));
 for(const invalid of [undefined,NaN,Infinity,{missing:undefined},new Date(),1n,Object.assign([],{[Symbol('hidden')]:1})])expect(()=>calibrationExperimentCanonical(invalid)).toThrow();
});
test('B original roster follows frozen replacement order and raw primary artist identities stay exact',()=>{
 const reversed=draft();reversed.replacementPool.reverse();expect(CalibrationExperimentDraftSchema.safeParse(reversed).success).toBe(false);
 const s=seal();s.queryGroups[s.evaluationCandidates[0]!.trackId]=' raw-artist-id ';
 expect(CalibrationExperimentSealInputSchema.parse(s).queryGroups[s.evaluationCandidates[0]!.trackId]).toBe(' raw-artist-id ');
});
test('Batch2 draft continues accepting the original 25/25/20 contract',()=>{
 const pool=candidates.map(c=>({...c,prediction:{...c.prediction,removalProbability:.5}}));
 expect(CalibrationBatchDraftSchema.safeParse({batchId,seed:42,algorithmVersion:'calibration-batch2:v1',modelVersion:prediction.modelVersion,selectedAt:at,candidates:pool,...selectCalibrationBatch(pool,42)}).success).toBe(true);
});
