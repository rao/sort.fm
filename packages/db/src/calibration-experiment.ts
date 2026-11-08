import {createHash} from 'node:crypto';
import {CalibrationExperimentDraftSchema,calibrationExperimentCanonical,calibrationExperimentSeedPrecommit,type CalibrationExperimentDraft} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';
import {lockUser,readLibrary} from './repository';
import {assertBatchCollecting} from './calibration-reservations';
import {CALIBRATION_BATCH3_EXPERIMENT,CONTRACT_VERSION,CalibrationExperimentIdSchema,CalibrationExperimentSchema,CalibrationExperimentReadySchema,CalibrationExperimentExclusionLedgerSchema,CalibrationExperimentSealInputSchema,CalibrationExperimentSealReceiptSchema,CalibrationExperimentReservationSchema,CalibrationExperimentSkipSchema,IdSchema,TimestampSchema,type CalibrationExperimentStore,type CalibrationExperimentExclusionLedger,type CalibrationExperimentSealInput,type CalibrationExperimentSkip,type CalibrationExperimentReservation,type CalibrationExperimentSnapshot,type CalibrationExperiment,type CalibrationExperimentReady,type CalibrationBatchSelection,type ExposureInput} from '@sortfm/contracts';
const fail=(code:string):never=>{throw new PersistenceError(code);};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const digest=(v:unknown)=>sha(calibrationExperimentCanonical(v));
export function experimentDigests(input:CalibrationExperimentDraft){
 const d=CalibrationExperimentDraftSchema.parse(input),eligibleTrackIdsSha256=digest(d.candidates.map(c=>c.track.trackId));
 if(d.eligibleTrackIdsSha256!==eligibleTrackIdsSha256||d.exclusionLedger.sortedIdsSha256!==digest(d.exclusionLedger.sortedTrackIds)||d.seedPrecommit.commitment!==sha(calibrationExperimentSeedPrecommit(d.batchId,d.protocolVersion,d.seedPrecommit.seed)))fail('BATCH_INVALID_DIGEST');
 return {snapshotSha256:digest(d),poolSha256:digest(d.candidates),rosterSha256:digest(d.selected),eligibleTrackIdsSha256};
}
const iso=(v:Date|string)=>new Date(v).toISOString();
async function ready(tx:Transaction){const [r]=await tx`SELECT to_regclass(current_schema()||'.calibration_experiments') IS NOT NULL AS ready`;if(!r.ready)fail('BATCH_UNAVAILABLE');}
function ledger(input:CalibrationExperimentExclusionLedger){const v=CalibrationExperimentExclusionLedgerSchema.parse(input);if(digest(v.sortedTrackIds)!==v.sortedIdsSha256)fail('BATCH_INVALID_DIGEST');return v;}
async function revisions(tx:Transaction,userId:string){const [r]=await tx`SELECT feedback_revision,membership_revision FROM users WHERE id=${userId}`;if(!r)fail('USER_NOT_FOUND');return {feedbackRevision:Number(r.feedback_revision),membershipRevision:Number(r.membership_revision)};}
async function eligibleIds(tx:Transaction,userId:string,exclusions:CalibrationExperimentExclusionLedger):Promise<string[]>{
 return (await tx`SELECT s.track_id FROM saved_tracks s JOIN tracks t USING(track_id) JOIN library_membership m USING(user_id,track_id)
 WHERE s.user_id=${userId} AND s.current_status IN ('saved','deferred') AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true'
 AND NOT EXISTS(SELECT 1 FROM unified_feedback f WHERE f.user_id=s.user_id AND f.track_id=s.track_id)
 AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.user_id=s.user_id AND d.track_id=s.track_id)
 AND NOT EXISTS(SELECT 1 FROM exposures e WHERE e.user_id=s.user_id AND e.track_id=s.track_id AND e.purpose='calibration')
 AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=s.user_id AND b.track_id=s.track_id)
 AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions d USING(user_id,decision_id) WHERE u.user_id=s.user_id AND d.track_id=s.track_id AND u.settled_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM policy_exposure_bindings p WHERE p.user_id=s.user_id AND p.track_id=s.track_id AND p.closed_at IS NULL AND p.expires_at>clock_timestamp())
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${json(exclusions.sortedTrackIds)}::jsonb) denied(id) WHERE denied.id=s.track_id)
 ORDER BY s.track_id COLLATE "C"`).map((r:any)=>r.track_id);
}
async function saved(tx:Transaction,userId:string){const [b]=await tx`SELECT b.*,x.phase,x.reservation,x.seal_request,x.seal_receipt FROM calibration_batches b JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=${userId} AND b.experiment=${CALIBRATION_BATCH3_EXPERIMENT}`;return b??null;}
function frozen(b:any):CalibrationExperimentSnapshot{
 const draft=CalibrationExperimentDraftSchema.parse(b.snapshot),reservation=CalibrationExperimentReservationSchema.parse(b.reservation);
 if(digest(experimentDigests(draft))!==digest(reservation.digests)||draft.batchId!==b.batch_id||reservation.batchId!==b.batch_id)fail('BATCH_INVALID_DIGEST');
 return {draft,reservation,seal:b.seal_receipt?CalibrationExperimentSealReceiptSchema.parse(b.seal_receipt):null};
}
function exposure(userId:string,c:CalibrationExperimentDraft['candidates'][number],position:number,at:string):ExposureInput{
 const p=c.prediction;return {userId,features:c.features,prediction:p,...(c.listeningContext?{listeningContext:c.listeningContext}:{}),exposure:{exposureId:crypto.randomUUID(),trackId:c.track.trackId,policy:'balanced',selectionMethod:'deterministic_baseline',policyVersion:'calibration-batch3:v1',explorationCoefficient:0,propensityEstimate:null,modelVersion:p.modelVersion,featureVersion:c.features.featureVersion,removalScore:p.removalProbability,heuristicScore:p.heuristicScore,uncertainty:p.uncertainty,position,servedAt:at}};
}
async function insertExposure(tx:Transaction,e:ExposureInput){await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${e.exposure.exposureId},${e.userId},${e.exposure.trackId},${json(e)}::jsonb,${e.exposure.servedAt},'calibration')`;}
async function assign(tx:Transaction,userId:string,d:CalibrationExperimentDraft,s:CalibrationBatchSelection,position:number,at:string,replacementFor:string|null=null){
 const c=d.candidates.find(c=>c.track.trackId===s.trackId)??fail('BATCH_INVALID_DIGEST'),e=exposure(userId,c,position,at),itemId=crypto.randomUUID();await insertExposure(tx,e);
 await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,exposure_id,replacement_for) VALUES(${itemId},${userId},${d.batchId},${s.trackId},${s.group},${s.assignment},${json(s)}::jsonb,${json(c)}::jsonb,${at},${position},${e.exposure.exposureId},${replacementFor})`;
 await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${itemId},${e.exposure.exposureId})`;
}
async function project(tx:Transaction,userId:string,at:string):Promise<CalibrationExperiment|null>{
 const b=await saved(tx,userId);if(!b)return null;
 const {draft:d,reservation:r,seal}=frozen(b);
 if(b.phase==='reserved')return CalibrationExperimentSchema.parse({batchId:b.batch_id,experiment:CALIBRATION_BATCH3_EXPERIMENT,phase:'reserved',reservedAt:r.reservedAt,target:60,groups:(['A','B','C'] as const).map(group=>({group,target:group==='A'?40:group==='B'?20:0,reserved:group==='A'?40:group==='B'?20:0}))});
 await assertBatchCollecting(tx,userId,b.batch_id);if(!seal)fail('BATCH_NOT_READY');
 const items=await tx`SELECT i.*,e.payload,(SELECT max(l.updated_at) FROM calibration_labels l WHERE l.user_id=i.user_id AND l.track_id=i.track_id) AS feedback_at,EXISTS(SELECT 1 FROM calibration_labels l WHERE l.user_id=i.user_id AND l.exposure_id=i.exposure_id) AS consumed FROM calibration_batch_items i JOIN exposures e ON e.user_id=i.user_id AND e.exposure_id=i.exposure_id WHERE i.user_id=${userId} AND i.batch_id=${b.batch_id} ORDER BY i.position`;
 for(const i of items)if(i.status==='revoked'&&(i.consumed||Date.parse(i.payload.exposure.servedAt)<=new Date(i.feedback_at).getTime())){
  const e=exposure(userId,i.candidate,i.position,new Date(Math.max(Date.parse(at),new Date(i.feedback_at).getTime()+1)).toISOString());await insertExposure(tx,e);
  await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${i.batch_item_id},${e.exposure.exposureId})`;await tx`UPDATE calibration_batch_items SET exposure_id=${e.exposure.exposureId} WHERE batch_item_id=${i.batch_item_id}`;i.exposure_id=e.exposure.exposureId;i.payload=e;
 }
 const entries=items.map((i:any)=>({...i.provenance,batchItemId:i.batch_item_id,exposureId:i.exposure_id,selectedAt:iso(i.selected_at),status:i.status,replacementFor:i.replacement_for}));
 const groups=(['A','B','C'] as const).map(group=>{const rows=entries.filter((e:any)=>e.group===group);return {group,target:group==='A'?40:group==='B'?20:0,labeled:rows.filter((e:any)=>e.status==='labeled').length,pending:rows.filter((e:any)=>['pending','revoked'].includes(e.status)).length,skipped:rows.filter((e:any)=>e.status==='skipped').length,revoked:rows.filter((e:any)=>e.status==='revoked').length};});
 const pending=items.filter((i:any)=>['pending','revoked'].includes(i.status));
 return CalibrationExperimentReadySchema.parse({batchId:b.batch_id,experiment:CALIBRATION_BATCH3_EXPERIMENT,phase:'ready',reservedAt:r.reservedAt,readyAt:seal!.readyAt,algorithmVersion:d.algorithmVersion,modelVersion:d.modelVersion,candidateCount:d.candidates.length,target:60,labeled:groups.reduce((n,g)=>n+g.labeled,0),sealedLabeled:groups[0]!.labeled,trainingLabeled:groups[1]!.labeled,groups,entries,queue:{contractVersion:CONTRACT_VERSION,mode:'calibration',items:pending.map((i:any)=>({track:i.candidate.track,prediction:i.payload.prediction,exposure:i.payload.exposure})),remaining:pending.length,nextCursor:null,fallbackReason:groups[1]!.labeled+groups[1]!.pending<20?'No eligible training replacement remains in the frozen pool.':null}});
}
export class PostgresCalibrationExperimentStore implements CalibrationExperimentStore {
 constructor(readonly db:Database){}
 async calibrationExperimentCandidates(userId:string,input:CalibrationExperimentExclusionLedger){IdSchema.parse(userId);const exclusions=ledger(input);return this.db.transaction(async tx=>{await lockUser(tx,userId);await ready(tx);return {library:await readLibrary(tx,userId),eligibleTrackIds:await eligibleIds(tx,userId,exclusions),ownerRevision:await revisions(tx,userId)};});}
 async calibrationExperiment(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT,now:string){IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);TimestampSchema.parse(now);return this.db.transaction(async tx=>{await lockUser(tx,userId);await ready(tx);return project(tx,userId,now);});}
 async calibrationExperimentSnapshot(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT){IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);return this.db.transaction(async tx=>{await ready(tx);const b=await saved(tx,userId);return b?frozen(b):null;});}
 async reserveCalibrationExperiment(userId:string,input:CalibrationExperimentDraft):Promise<CalibrationExperimentReservation>{
  IdSchema.parse(userId);const d=CalibrationExperimentDraftSchema.parse(input),digests=experimentDigests(d);
  return this.db.transaction(async tx=>{
   await lockUser(tx,userId);await ready(tx);const old=await saved(tx,userId);
   if(old){const s=frozen(old);if(s.reservation.digests.snapshotSha256!==digests.snapshotSha256)fail('IDEMPOTENCY_CONFLICT');return s.reservation;}
   if(digest(await revisions(tx,userId))!==digest(d.ownerRevision)||digest(await eligibleIds(tx,userId,d.exclusionLedger))!==digests.eligibleTrackIdsSha256)fail('BATCH_CANDIDATES_CHANGED');
   const [clock]=await tx`SELECT clock_timestamp() AS now`;const reservedAt=iso(clock.now);if(Date.parse(d.selectedAt)>Date.parse(reservedAt))fail('BATCH_SEAL_CHRONOLOGY');
   const reservation=CalibrationExperimentReservationSchema.parse({batchId:d.batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,reservedAt,ownerRevision:d.ownerRevision,digests});
   await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot) VALUES(${d.batchId},${userId},${d.experiment},${d.seedPrecommit.seed},${d.algorithmVersion},${d.modelVersion},${d.selectedAt},${json(d)}::jsonb)`;
   await tx`INSERT INTO calibration_experiments(user_id,batch_id,reservation) VALUES(${userId},${d.batchId},${json(reservation)}::jsonb)`;
   for(const [i,s] of d.selected.entries())await assign(tx,userId,d,s,i,d.selectedAt);
   return reservation;
  });
 }
 async sealCalibrationExperiment(userId:string,input:CalibrationExperimentSealInput){
  IdSchema.parse(userId);const request=CalibrationExperimentSealInputSchema.parse(input),requestFingerprint=digest(request);
  return this.db.transaction(async tx=>{
   await lockUser(tx,userId);await ready(tx);const b=await saved(tx,userId);if(!b||b.batch_id!==request.batchId)fail('BATCH_NOT_FOUND');const s=frozen(b);
   if(s.seal){if(s.seal.requestFingerprint!==requestFingerprint||digest(b.seal_request)!==requestFingerprint)fail('IDEMPOTENCY_CONFLICT');return s.seal;}
   const a=s.draft.selected.slice(0,40).map(item=>s.draft.candidates.find(c=>c.track.trackId===item.trackId)!);
   if(digest(request.expected)!==digest(s.reservation.digests)||digest(request.research)!==digest(s.draft.research)||digest(request.evaluationCandidates)!==digest(a.map(c=>({trackId:c.track.trackId,features:c.features})))||digest(request.queryGroups)!==digest(Object.fromEntries(a.map(c=>[c.track.trackId,c.track.artists[0]?.id??null]))))fail('BATCH_SEAL_MISMATCH');
   const [events]=await tx`SELECT count(*)::int AS n FROM unified_feedback f WHERE f.user_id=${userId} AND EXISTS(SELECT 1 FROM calibration_batch_items i WHERE i.user_id=f.user_id AND i.batch_id=${request.batchId} AND i.track_id=f.track_id)`;if(events.n!==0)fail('BATCH_FEEDBACK_EXISTS');
   const [checked]=await tx`SELECT clock_timestamp() AS now`;const checkedAt=iso(checked.now);if(Date.parse(request.externalSealedAt)>Date.parse(checkedAt))fail('BATCH_SEAL_CHRONOLOGY');
   // PostgreSQL clocks have finer precision than the wire's milliseconds. Bound
   // the wait for a distinct actual observation; never manufacture checkedAt+1.
   const [opened]=await tx`SELECT clock_timestamp() AS now`;let readyAt=iso(opened.now);
   for(let attempt=0;Date.parse(readyAt)<=Date.parse(checkedAt)&&attempt<20;attempt++){
    const [later]=await tx`SELECT clock_timestamp() AS now FROM pg_sleep(0.001)`;readyAt=iso(later.now);
   }
   if(Date.parse(readyAt)<=Date.parse(checkedAt))fail('BATCH_SEAL_CHRONOLOGY');
   const receipt=CalibrationExperimentSealReceiptSchema.parse({batchId:b.batch_id,experiment:CALIBRATION_BATCH3_EXPERIMENT,idempotencyKey:request.idempotencyKey,requestFingerprint,digests:s.reservation.digests,research:request.research,artifacts:request.artifacts,externalSealedAt:request.externalSealedAt,checkedAt,readyAt,everFeedbackCount:0});
   await tx`UPDATE calibration_experiments SET phase='ready',seal_request=${json(request)}::jsonb,seal_receipt=${json(receipt)}::jsonb WHERE user_id=${userId} AND batch_id=${b.batch_id}`;return receipt;
  });
 }
 async skipCalibrationExperiment(userId:string,experiment:typeof CALIBRATION_BATCH3_EXPERIMENT,input:CalibrationExperimentSkip,now:string):Promise<CalibrationExperimentReady>{
  IdSchema.parse(userId);CalibrationExperimentIdSchema.parse(experiment);TimestampSchema.parse(now);const request=CalibrationExperimentSkipSchema.parse(input);
  return this.db.transaction(async tx=>{
   await lockUser(tx,userId);await ready(tx);const b=await saved(tx,userId);if(!b)fail('BATCH_NOT_FOUND');await assertBatchCollecting(tx,userId,b.batch_id);
   const [old]=await tx`SELECT * FROM calibration_batch_skips WHERE user_id=${userId} AND idempotency_key=${request.idempotencyKey}`;
   if(old){const [item]=await tx`SELECT batch_id FROM calibration_batch_items WHERE user_id=${userId} AND batch_item_id=${old.batch_item_id}`;if(old.exposure_id!==request.exposureId||item?.batch_id!==b.batch_id)fail('IDEMPOTENCY_CONFLICT');return CalibrationExperimentReadySchema.parse(await project(tx,userId,now));}
   const [item]=await tx`SELECT i.* FROM calibration_batch_items i JOIN calibration_batch_exposures e USING(user_id,batch_item_id) WHERE i.user_id=${userId} AND i.batch_id=${b.batch_id} AND e.exposure_id=${request.exposureId}`;
   if(!item)fail('BATCH_ITEM_NOT_FOUND');if(item.exposure_id!==request.exposureId||!['pending','revoked'].includes(item.status))fail('BATCH_ITEM_NOT_PENDING');
   const s=frozen(b);if(Date.parse(now)<Date.parse(s.seal!.readyAt)||Date.parse(now)<new Date(item.selected_at).getTime())fail('BATCH_SEAL_CHRONOLOGY');
   await tx`INSERT INTO calibration_batch_skips(user_id,idempotency_key,exposure_id,batch_item_id,created_at) VALUES(${userId},${request.idempotencyKey},${request.exposureId},${item.batch_item_id},${now})`;await tx`UPDATE calibration_batch_items SET status='skipped' WHERE batch_item_id=${item.batch_item_id}`;
   if(item.sampling_group==='B'){
    const eligible=new Set(await eligibleIds(tx,userId,s.draft.exclusionLedger)),next=s.draft.replacementPool.find(c=>eligible.has(c.trackId));
    if(next){const [p]=await tx`SELECT max(position)+1 AS position FROM calibration_batch_items WHERE user_id=${userId} AND batch_id=${b.batch_id}`;await assign(tx,userId,s.draft,next,p.position,now,item.batch_item_id);}
   }
   return CalibrationExperimentReadySchema.parse(await project(tx,userId,now));
  });
 }
}
