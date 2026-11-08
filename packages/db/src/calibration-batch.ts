import {CALIBRATION_BATCH_EXPERIMENT,CONTRACT_VERSION,FEATURE_VERSION,CalibrationBatchDraftSchema,CalibrationBatchSchema,CalibrationBatchSkipSchema,IdSchema,TimestampSchema,type CalibrationBatch,type CalibrationBatchDraft,type CalibrationBatchSelection,type CalibrationBatchSkip,type CalibrationBatchStore,type CalibrationCandidateSnapshot,type ExposureInput} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';
import {lockUser,readLibrary} from './repository';
import {assertBatchCollecting,batchStorageReady} from './calibration-reservations';
const fail=(code:string):never=>{throw new PersistenceError(code);};
const iso=(v:Date|string)=>new Date(v).toISOString();
async function ready(tx:Transaction){if(!await batchStorageReady(tx))fail('BATCH_UNAVAILABLE');}
async function eligibleIds(tx:Transaction,userId:string):Promise<string[]>{return (await tx`
 SELECT s.track_id FROM saved_tracks s JOIN tracks t USING(track_id) JOIN library_membership m USING(user_id,track_id)
 WHERE s.user_id=${userId} AND s.current_status IN ('saved','deferred') AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true'
 AND NOT EXISTS(SELECT 1 FROM calibration_labels l WHERE l.user_id=s.user_id AND l.track_id=s.track_id)
 AND NOT EXISTS(SELECT 1 FROM review_decisions d WHERE d.user_id=s.user_id AND d.track_id=s.track_id)
 AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=s.user_id AND b.track_id=s.track_id)
 ORDER BY s.track_id`).map((r:any)=>r.track_id);}
function exposure(userId:string,candidate:CalibrationBatchDraft['candidates'][number],position:number,servedAt:string):ExposureInput{
 const p=candidate.prediction;
 return {userId,features:candidate.features,prediction:p,...(candidate.listeningContext?{listeningContext:candidate.listeningContext}:{}),exposure:{exposureId:crypto.randomUUID(),trackId:candidate.track.trackId,policy:'balanced',selectionMethod:'deterministic_baseline',policyVersion:'calibration-batch2:v1',explorationCoefficient:0,propensityEstimate:null,modelVersion:p.modelVersion,featureVersion:FEATURE_VERSION,removalScore:p.removalProbability,heuristicScore:p.heuristicScore,uncertainty:p.uncertainty,position,servedAt}};
}
async function insertExposure(tx:Transaction,e:ExposureInput){await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${e.exposure.exposureId},${e.userId},${e.exposure.trackId},${json(e)}::jsonb,${e.exposure.servedAt},'calibration')`;}
async function reserve(tx:Transaction,userId:string,draft:CalibrationBatchDraft,selection:CalibrationBatchSelection,position:number,at:string,replacementFor:string|null=null){
 const candidate=draft.candidates.find(c=>c.track.trackId===selection.trackId)??fail('BATCH_INVALID_SNAPSHOT');
 const itemId=crypto.randomUUID(),e=exposure(userId,candidate,position,at);await insertExposure(tx,e);
 await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,exposure_id,replacement_for)
 VALUES(${itemId},${userId},${draft.batchId},${selection.trackId},${selection.group},${selection.assignment},${json(selection)}::jsonb,${json(candidate)}::jsonb,${at},${position},${e.exposure.exposureId},${replacementFor})`;
 await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${itemId},${e.exposure.exposureId})`;
}
async function project(tx:Transaction,userId:string,at:string):Promise<CalibrationBatch|null>{
 const [batch]=await tx`SELECT * FROM calibration_batches WHERE user_id=${userId} AND experiment=${CALIBRATION_BATCH_EXPERIMENT}`;if(!batch)return null;
 const items=await tx`SELECT b.*,e.payload,(SELECT max(l.updated_at) FROM calibration_labels l WHERE l.user_id=b.user_id AND l.track_id=b.track_id) AS feedback_at,EXISTS(SELECT 1 FROM calibration_labels l WHERE l.user_id=b.user_id AND l.exposure_id=b.exposure_id) AS consumed FROM calibration_batch_items b JOIN exposures e ON e.user_id=b.user_id AND e.exposure_id=b.exposure_id WHERE b.user_id=${userId} AND b.batch_id=${batch.batch_id} ORDER BY b.position`;
 for(const b of items){
  // Undo consumes the old exposure forever. Renew only the exposure, using the
  // exact frozen candidate and stable item identity; no model/provider call.
  if(b.status==='revoked'&&(b.consumed||Date.parse(b.payload.exposure.servedAt)<=new Date(b.feedback_at).getTime())){
   const renewedAt=new Date(Math.max(Date.parse(at),new Date(b.feedback_at).getTime()+1)).toISOString();
   const e=exposure(userId,b.candidate,b.position,renewedAt);await insertExposure(tx,e);
   await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${b.batch_item_id},${e.exposure.exposureId})`;
   await tx`UPDATE calibration_batch_items SET exposure_id=${e.exposure.exposureId} WHERE batch_item_id=${b.batch_item_id}`;
   b.exposure_id=e.exposure.exposureId;b.payload=e;
  }
 }
 const entries:CalibrationBatch['entries']=items.map((b:any)=>({...b.provenance,batchItemId:b.batch_item_id,exposureId:b.exposure_id,selectedAt:iso(b.selected_at),status:b.status,replacementFor:b.replacement_for}));
 const groups=(['A','B','C'] as const).map(group=>{const rows=entries.filter(e=>e.group===group);return {group,target:group==='C'?20:25,labeled:rows.filter(e=>e.status==='labeled').length,pending:rows.filter(e=>e.status==='pending'||e.status==='revoked').length,skipped:rows.filter(e=>e.status==='skipped').length,revoked:rows.filter(e=>e.status==='revoked').length};});
 const pending=items.filter((b:any)=>b.status==='pending'||b.status==='revoked');
 const shortfall=groups.some(g=>g.labeled+g.pending<g.target);
 return CalibrationBatchSchema.parse({batchId:batch.batch_id,experiment:batch.experiment,seed:batch.seed,algorithmVersion:batch.algorithm_version,modelVersion:batch.model_version,selectedAt:iso(batch.selected_at),candidateCount:batch.snapshot.candidates.length,target:70,labeled:groups.reduce((n,g)=>n+g.labeled,0),sealedLabeled:groups[0]!.labeled,trainingLabeled:groups[1]!.labeled+groups[2]!.labeled,groups,entries,
 queue:{contractVersion:CONTRACT_VERSION,mode:'calibration',items:pending.slice(0,100).map((b:any)=>({track:b.candidate.track,prediction:b.payload.prediction,exposure:b.payload.exposure})),remaining:pending.length,nextCursor:null,fallbackReason:shortfall?'A sampling group has no eligible replacement in its frozen pool. Skips remain unlabeled; the saved batch has not been regenerated.':null}});
}
export class PostgresCalibrationBatchStore implements CalibrationBatchStore {
 constructor(readonly db:Database){}
 async calibrationBatchCandidates(userId:string):Promise<CalibrationCandidateSnapshot>{IdSchema.parse(userId);return this.db.transaction(async tx=>{await lockUser(tx,userId);await ready(tx);return {library:await readLibrary(tx,userId),eligibleTrackIds:await eligibleIds(tx,userId)};});}
 async calibrationBatch(userId:string,now:string){IdSchema.parse(userId);TimestampSchema.parse(now);return this.db.transaction(async tx=>{await lockUser(tx,userId);await ready(tx);return project(tx,userId,now);});}
 async createCalibrationBatch(userId:string,input:CalibrationBatchDraft){IdSchema.parse(userId);const draft=CalibrationBatchDraftSchema.parse(input);return this.db.transaction(async tx=>{
  await lockUser(tx,userId);await ready(tx);
  const old=await project(tx,userId,draft.selectedAt);if(old){if(old.seed!==draft.seed)fail('BATCH_SEED_CONFLICT');return old;}
  const ids=new Set(draft.candidates.map(c=>c.track.trackId)),selected=new Set(draft.selected.map(c=>c.trackId));
  if(ids.size!==draft.candidates.length||selected.size!==70||draft.candidates.some(c=>c.prediction.modelVersion!==draft.modelVersion||c.features.featureVersion!==FEATURE_VERSION))fail('BATCH_INVALID_SNAPSHOT');
  for(const group of ['A','B','C'] as const){
   const items=draft.selected.filter(s=>s.group===group);if(items.length!==(group==='C'?20:25))fail('BATCH_INVALID_SNAPSHOT');
   if(draft.pools[group].some(s=>s.group!==group||!ids.has(s.trackId)||s.assignment!==(group==='A'?'sealed_evaluation':'train'))||new Set(draft.pools[group].map(s=>s.trackId)).size!==draft.pools[group].length)fail('BATCH_INVALID_SNAPSHOT');
   for(const s of items)if(!draft.pools[group].some(p=>json(p)===json(s)))fail('BATCH_INVALID_SNAPSHOT');
  }
  const eligible=new Set(await eligibleIds(tx,userId));if(draft.selected.some(s=>!eligible.has(s.trackId)))fail('BATCH_CANDIDATES_CHANGED');
  await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot) VALUES(${draft.batchId},${userId},${CALIBRATION_BATCH_EXPERIMENT},${draft.seed},${draft.algorithmVersion},${draft.modelVersion},${draft.selectedAt},${json(draft)}::jsonb)`;
  for(const [i,s] of draft.selected.entries())await reserve(tx,userId,draft,s,i,draft.selectedAt);
  return (await project(tx,userId,draft.selectedAt))!;
 });}
 async skipCalibrationBatch(userId:string,input:CalibrationBatchSkip,now:string){IdSchema.parse(userId);const request=CalibrationBatchSkipSchema.parse(input);TimestampSchema.parse(now);return this.db.transaction(async tx=>{
  await lockUser(tx,userId);await ready(tx);
  const [old]=await tx`SELECT * FROM calibration_batch_skips WHERE user_id=${userId} AND idempotency_key=${request.idempotencyKey}`;
  if(old){if(old.exposure_id!==request.exposureId)fail('IDEMPOTENCY_CONFLICT');const [kind]=await tx`SELECT b.experiment FROM calibration_batch_items i JOIN calibration_batches b USING(user_id,batch_id) WHERE i.user_id=${userId} AND i.batch_item_id=${old.batch_item_id}`;if(kind?.experiment!==CALIBRATION_BATCH_EXPERIMENT)fail('BATCH_ITEM_NOT_FOUND');return (await project(tx,userId,now))!;}
  const [item]=await tx`SELECT b.* FROM calibration_batch_items b JOIN calibration_batch_exposures e USING(user_id,batch_item_id) WHERE e.user_id=${userId} AND e.exposure_id=${request.exposureId}`;
  if(!item)fail('BATCH_ITEM_NOT_FOUND');await assertBatchCollecting(tx,userId,item.batch_id);const [kind]=await tx`SELECT experiment FROM calibration_batches WHERE user_id=${userId} AND batch_id=${item.batch_id}`;if(kind?.experiment!==CALIBRATION_BATCH_EXPERIMENT)fail('BATCH_ITEM_NOT_FOUND');if(item.exposure_id!==request.exposureId||!['pending','revoked'].includes(item.status))fail('BATCH_ITEM_NOT_PENDING');
  await tx`INSERT INTO calibration_batch_skips(user_id,idempotency_key,exposure_id,batch_item_id,created_at) VALUES(${userId},${request.idempotencyKey},${request.exposureId},${item.batch_item_id},${now})`;
  await tx`UPDATE calibration_batch_items SET status='skipped' WHERE batch_item_id=${item.batch_item_id}`;
  const [batch]=await tx`SELECT snapshot FROM calibration_batches WHERE user_id=${userId} AND batch_id=${item.batch_id}`;const draft=batch.snapshot as CalibrationBatchDraft;
  const eligible=new Set(await eligibleIds(tx,userId));
  const candidates=draft.pools[item.sampling_group as 'A'|'B'|'C'].filter(s=>eligible.has(s.trackId));
  const next=candidates[0];
  if(next){const [pos]=await tx`SELECT COALESCE(max(position),-1)+1 AS next FROM calibration_batch_items WHERE user_id=${userId} AND batch_id=${item.batch_id}`;
   await reserve(tx,userId,draft,{...next,selectionProbability:next.group==='A'?1/candidates.length:null},pos.next,now,item.batch_item_id);
  }
  return (await project(tx,userId,now))!;
 });}
}
