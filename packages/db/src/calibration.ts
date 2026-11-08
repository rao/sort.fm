import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CalibrationCorrectionRequestSchema,CalibrationLabelRequestSchema,CalibrationLabelResultSchema,CalibrationHistorySchema,ExposureInputSchema,IdSchema,UuidSchema,TimestampSchema,UndoRequestSchema,type CalibrationCorrectionInput,type CalibrationStore,type CalibrationCandidateSnapshot,type CalibrationHistory,type CalibrationLabelInput,type CalibrationLabelResult,type CalibrationUndoInput,type ExposureInput} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';
import {lockUser,readLibrary} from './repository';
import {assertPublishedReviewExposure} from './review-exclusions';
import {ready as policyStorageReady} from './policy-core';
import {assertBatchCollecting,assertNotBatchReserved,batchExposure,reservedCalibrationTrackIds} from './calibration-reservations';
const correctionInput=z.strictObject({userId:IdSchema,labelId:UuidSchema,exposureId:UuidSchema,request:CalibrationCorrectionRequestSchema,requestFingerprint:z.string().min(1),createdAt:TimestampSchema});
const labelInput=z.strictObject({userId:IdSchema,labelId:UuidSchema,request:CalibrationLabelRequestSchema,requestFingerprint:z.string().min(1),createdAt:TimestampSchema});
const undoInput=z.strictObject({userId:IdSchema,commandId:UuidSchema,labelId:UuidSchema,request:UndoRequestSchema,requestFingerprint:z.string().min(1),createdAt:TimestampSchema});
const fail=(code:string):never=>{throw new PersistenceError(code);};
const iso=(value:Date|string)=>new Date(value).toISOString();
/** Matches C1's first-eight-byte SHA-256 split; label values never enter the hash. */
export function calibrationSplit(userId:string,trackId:string):'train'|'holdout'{return createHash('sha256').update(JSON.stringify([42,userId,trackId])).digest().readBigUInt64BE()%5n===0n?'holdout':'train';}
async function pending(tx:Transaction,userId:string,trackId:string){const [row]=await tx`SELECT EXISTS(SELECT 1 FROM review_decisions WHERE user_id=${userId} AND track_id=${trackId} AND result->>'status' IN ('PENDING','FAILED_RETRYABLE')) OR EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions d USING(user_id,decision_id) WHERE u.user_id=${userId} AND d.track_id=${trackId} AND u.settled_at IS NULL) AS pending`;return row.pending as boolean;}
async function eligible(tx:Transaction,userId:string,trackId:string,servedAt?:string){
 const [row]=await tx`SELECT t.card,s.current_status,EXISTS(SELECT 1 FROM library_membership WHERE user_id=${userId} AND track_id=${trackId}) AS member,d.result FROM saved_tracks s JOIN tracks t USING(track_id) LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id WHERE s.user_id=${userId} AND s.track_id=${trackId}`;
 if(!row)fail('TRACK_NOT_OWNED');if(!row.member)fail('TRACK_NOT_IN_LIBRARY');
 if(await pending(tx,userId,trackId))fail('MUTATION_PENDING');
 if(row.card.source!=='spotify'||!row.card.isPlayable||!['saved','deferred'].includes(row.current_status)||row.result?.status==='COMPLETE')fail('CALIBRATION_NOT_ELIGIBLE');
 const [winner]=await tx`SELECT * FROM effective_feedback WHERE user_id=${userId} AND track_id=${trackId}`;
 if(winner?.label!==null&&winner?.label!==undefined&&!winner.revoked)fail('CALIBRATION_LABEL_ACTIVE');
 if(servedAt){const latest=Math.max(row.result?Date.parse(row.result.updatedAt):0,winner?new Date(winner.occurred_at).getTime():0);if(Date.parse(servedAt)<=latest)fail('STALE_EXPOSURE');}
 return winner;
}
async function projections(tx:Transaction,userId:string,labelId?:string):Promise<CalibrationLabelResult[]>{
 const rows=await tx`SELECT l.*,f.decision_id AS winner_id,f.source AS winner_source,f.revision AS winner_revision,f.occurred_at AS winner_at,
  EXISTS(SELECT 1 FROM review_decisions d WHERE d.user_id=l.user_id AND d.track_id=l.track_id AND d.result->>'status' IN ('PENDING','FAILED_RETRYABLE')) OR EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions d USING(user_id,decision_id) WHERE u.user_id=l.user_id AND d.track_id=l.track_id AND u.settled_at IS NULL) AS pending
  FROM calibration_labels l LEFT JOIN effective_feedback f USING(user_id,track_id) WHERE l.user_id=${userId} AND (${labelId??null}::uuid IS NULL OR l.label_id=${labelId??null}::uuid) ORDER BY l.created_at DESC,l.label_id DESC`;
 return rows.map((row:any)=>{
  const state=row.revoked?'revoked':row.winner_source==='calibration'&&row.winner_id===row.label_id?'active':'superseded';
  return CalibrationLabelResultSchema.parse({mode:'calibration',labelId:row.label_id,trackId:row.track_id,exposureId:row.exposure_id,idempotencyKey:row.idempotency_key,submittedLabel:row.submitted_label,label:state==='active'?row.submitted_label:null,state,canUndo:state==='active'&&!row.pending,feedbackRevision:state==='superseded'?row.winner_revision:row.revision,createdAt:iso(row.created_at),updatedAt:state==='superseded'?new Date(Math.max(new Date(row.updated_at).getTime(),new Date(row.winner_at).getTime())).toISOString():iso(row.updated_at)});
 });
}
async function project(tx:Transaction,userId:string,labelId:string):Promise<CalibrationLabelResult>{return (await projections(tx,userId,labelId))[0]??fail('CALIBRATION_LABEL_NOT_FOUND');}
async function advance(tx:Transaction,userId:string,revision:number){await tx`UPDATE users SET feedback_revision=${revision} WHERE id=${userId}`;await tx`INSERT INTO feedback_sync_jobs(user_id,target_revision) VALUES(${userId},${revision}) ON CONFLICT(user_id) DO UPDATE SET target_revision=GREATEST(feedback_sync_jobs.target_revision,excluded.target_revision),available_at=LEAST(feedback_sync_jobs.available_at,clock_timestamp()),updated_at=clock_timestamp()`;}
/** Correction labels remain preference events; pilot access is bound to the original
 * published Skip even after that review is undone or superseded. Ordinary inherited
 * calibration rows cannot become visible or undoable through the pilot allowlist. */
async function assertPilotCorrectionLabel(tx:Transaction,db:Database,userId:string,labelId:string){
 const policy=db.reviewExclusions;if(!policy)return;policy.assertOwner(userId);
 const [label]=await tx`SELECT track_id,exposure_id,request FROM calibration_labels WHERE user_id=${userId} AND label_id=${labelId}`;
 const original=CalibrationCorrectionRequestSchema.safeParse(label?.request?.originalCorrectionRequest);
 if(!original.success)return fail('CALIBRATION_LABEL_NOT_FOUND');
 if(label.request.trackId!==label.track_id||label.request.exposureId!==label.exposure_id||label.request.label!==1||label.request.idempotencyKey!==original.data.idempotencyKey)fail('CALIBRATION_LABEL_NOT_FOUND');
 const [source]=await tx`SELECT track_id,exposure_id,request,result FROM review_decisions WHERE user_id=${userId} AND decision_id=${original.data.decisionId}`;
 if(!source||source.track_id!==label.track_id||source.request.action!=='SKIP'||source.result.action!=='SKIP'||source.result.mode!=='spotify'||source.result.trackId!==source.track_id||source.result.exposureId!==source.exposure_id)fail('CALIBRATION_LABEL_NOT_FOUND');
 await assertPublishedReviewExposure(tx,policy,userId,source.exposure_id,source.track_id);
}
export class PostgresCalibrationStore implements CalibrationStore {
 constructor(readonly db:Database){}
 async calibrationCandidates(userId:string):Promise<CalibrationCandidateSnapshot>{IdSchema.parse(userId);return this.db.transaction(async tx=>{
  await lockUser(tx,userId);const library=await readLibrary(tx,userId);
  const rows=await tx`SELECT s.track_id FROM saved_tracks s JOIN tracks t USING(track_id) JOIN library_membership m ON m.user_id=s.user_id AND m.track_id=s.track_id LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id LEFT JOIN effective_feedback f ON f.user_id=s.user_id AND f.track_id=s.track_id WHERE s.user_id=${userId} AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true' AND s.current_status IN ('saved','deferred') AND (d.result IS NULL OR d.result->>'status' IN ('UNDONE','FAILED_TERMINAL')) AND (f.label IS NULL OR f.revoked) AND NOT EXISTS(SELECT 1 FROM review_decisions r WHERE r.user_id=s.user_id AND r.track_id=s.track_id AND r.result->>'status' IN ('PENDING','FAILED_RETRYABLE')) AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions r USING(user_id,decision_id) WHERE u.user_id=s.user_id AND r.track_id=s.track_id AND u.settled_at IS NULL) ORDER BY s.track_id`;
  const reserved=new Set(await reservedCalibrationTrackIds(tx,userId));return {library,eligibleTrackIds:rows.map((r:any)=>r.track_id).filter((id:string)=>!reserved.has(id))};
 });}
 async insertCalibrationExposure(input:ExposureInput):Promise<void>{const v=ExposureInputSchema.parse(input);await this.db.transaction(async tx=>{
  await lockUser(tx,v.userId);await assertNotBatchReserved(tx,v.userId,v.exposure.trackId);await eligible(tx,v.userId,v.exposure.trackId,v.exposure.servedAt);
  const rows=await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${v.exposure.exposureId},${v.userId},${v.exposure.trackId},${json(v)}::jsonb,${v.exposure.servedAt},'calibration') ON CONFLICT DO NOTHING RETURNING exposure_id`;
  if(!rows.length){const [same]=await tx`SELECT 1 FROM exposures WHERE user_id=${v.userId} AND exposure_id=${v.exposure.exposureId} AND purpose='calibration' AND payload=${json(v)}::jsonb`;if(!same)fail('EXPOSURE_CONFLICT');}
 });}
 async createCalibrationLabel(input:CalibrationLabelInput):Promise<CalibrationLabelResult>{const v=labelInput.parse(input);return this.db.transaction(async tx=>{
  const owner=await lockUser(tx,v.userId);
  const [old]=await tx`SELECT label_id,request_fingerprint=${v.requestFingerprint} AND request=${json(v.request)}::jsonb AS same FROM calibration_labels WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey}`;
  if(old){if(!old.same)fail('IDEMPOTENCY_CONFLICT');return project(tx,v.userId,old.label_id);}
  const [e]=await tx`SELECT track_id,purpose,served_at FROM exposures WHERE user_id=${v.userId} AND exposure_id=${v.request.exposureId}`;
  if(!e)fail('EXPOSURE_NOT_FOUND');if(e.purpose!=='calibration')fail('EXPOSURE_PURPOSE_MISMATCH');if(e.track_id!==v.request.trackId)fail('EXPOSURE_TRACK_MISMATCH');
  if((await tx`SELECT 1 FROM calibration_labels WHERE user_id=${v.userId} AND exposure_id=${v.request.exposureId}`).length)fail('EXPOSURE_ALREADY_CONSUMED');
  const batch=await batchExposure(tx,v.userId,v.request.exposureId);
  if(batch){await assertBatchCollecting(tx,v.userId,batch.batch_id);if(batch.exposure_id!==v.request.exposureId||!['pending','revoked'].includes(batch.status))fail('BATCH_ITEM_NOT_PENDING');}else await assertNotBatchReserved(tx,v.userId,v.request.trackId);
  const winner=await eligible(tx,v.userId,v.request.trackId,iso(e.served_at));if(Date.parse(v.createdAt)<new Date(e.served_at).getTime())fail('STALE_EXPOSURE');
  const revision=Number(owner.feedback_revision)+1,split=batch?(batch.assignment==='train'?'train':'holdout'):winner?.split??calibrationSplit(v.userId,v.request.trackId);
  await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revision,split,created_at,updated_at) VALUES(${v.labelId},${v.userId},${v.request.trackId},${v.request.exposureId},${v.request.idempotencyKey},${v.requestFingerprint},${json(v.request)}::jsonb,${v.request.label},${v.request.label},${revision},${split},${v.createdAt},${v.createdAt})`;
  if(batch)await tx`UPDATE calibration_batch_items SET status='labeled' WHERE batch_item_id=${batch.batch_item_id}`;
  await advance(tx,v.userId,revision);return project(tx,v.userId,v.labelId);
 });}
 /** Explicit post-collection Remove preference. No review/policy/provider state is rewritten. */
 async correctSkippedPreference(input:CalibrationCorrectionInput):Promise<CalibrationLabelResult>{const v=correctionInput.parse(input);return this.db.transaction(async tx=>{
  this.db.reviewExclusions?.assertOwner(v.userId);const owner=await lockUser(tx,v.userId);
  const [old]=await tx`SELECT label_id,request_fingerprint=${v.requestFingerprint} AND request->'originalCorrectionRequest'=${json(v.request)}::jsonb AS same FROM calibration_labels WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey}`;
  if(old){if(!old.same)fail('IDEMPOTENCY_CONFLICT');await assertPilotCorrectionLabel(tx,this.db,v.userId,old.label_id);return project(tx,v.userId,old.label_id);}
  const [source]=await tx`SELECT d.*,e.payload,e.purpose,c.decision_id AS current_id,s.current_status,t.card,
   EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=d.user_id AND m.track_id=d.track_id) AS member
   FROM review_decisions d JOIN exposures e ON e.user_id=d.user_id AND e.exposure_id=d.exposure_id
   JOIN saved_tracks s ON s.user_id=d.user_id AND s.track_id=d.track_id JOIN tracks t ON t.track_id=d.track_id
   LEFT JOIN current_decisions c ON c.user_id=d.user_id AND c.track_id=d.track_id
   WHERE d.user_id=${v.userId} AND d.decision_id=${v.request.decisionId}`;
  if(!source)fail('DECISION_NOT_FOUND');
  await assertPublishedReviewExposure(tx,this.db.reviewExclusions,v.userId,source.exposure_id,source.track_id);
  await assertNotBatchReserved(tx,v.userId,source.track_id);
  if(await pending(tx,v.userId,source.track_id))fail('MUTATION_PENDING');
  if(await policyStorageReady(tx)){
   if((await tx`SELECT 1 FROM policy_exposure_bindings WHERE user_id=${v.userId} AND track_id=${source.track_id} AND closed_at IS NULL AND expires_at>clock_timestamp() LIMIT 1`).length)fail('MUTATION_PENDING');
  }
  const r=source.result;
  if(source.current_id!==v.request.decisionId||source.request.action!=='SKIP'||r.action!=='SKIP'||r.status!=='COMPLETE'||r.label!==null||r.labelState!=='inactive'||r.mode!=='spotify'||r.decisionId!==v.request.decisionId||r.trackId!==source.track_id||r.exposureId!==source.exposure_id||source.purpose!=='review'||!source.member||source.card.source!=='spotify'||!source.card.isPlayable||!['saved','deferred'].includes(source.current_status))fail('CALIBRATION_NOT_ELIGIBLE');
  // Ever-held-out identities remain held out even when their latest label is revoked.
  if((await tx`SELECT 1 FROM unified_feedback WHERE user_id=${v.userId} AND track_id=${source.track_id} AND split='holdout' LIMIT 1`).length)fail('CALIBRATION_NOT_ELIGIBLE');
  const [winner]=await tx`SELECT label,revoked FROM effective_feedback WHERE user_id=${v.userId} AND track_id=${source.track_id}`;
  if(winner?.label!==null&&winner?.label!==undefined&&!winner.revoked)fail('CALIBRATION_LABEL_ACTIVE');
  if(Date.parse(v.createdAt)<Date.parse(r.updatedAt))fail('STALE_EXPOSURE');
  const original=ExposureInputSchema.parse(source.payload);
  if(original.userId!==v.userId||original.exposure.trackId!==source.track_id||original.exposure.exposureId!==source.exposure_id)fail('CALIBRATION_NOT_ELIGIBLE');
  const {policyTelemetry:_policyTelemetry,...frozenExposure}=original.exposure;
  const exposure=ExposureInputSchema.parse({...original,exposure:{...frozenExposure,exposureId:v.exposureId,servedAt:v.createdAt,selectionMethod:'deterministic_baseline',policyVersion:'post-collection:skip-correction:v1',explorationCoefficient:0,propensityEstimate:null}});
  const request={trackId:source.track_id,exposureId:v.exposureId,label:1,idempotencyKey:v.request.idempotencyKey,originalCorrectionRequest:v.request};
  const revision=Number(owner.feedback_revision)+1;
  await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${v.exposureId},${v.userId},${source.track_id},${json(exposure)}::jsonb,${v.createdAt},'calibration')`;
  await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revision,split,created_at,updated_at) VALUES(${v.labelId},${v.userId},${source.track_id},${v.exposureId},${v.request.idempotencyKey},${v.requestFingerprint},${json(request)}::jsonb,1,1,${revision},'train',${v.createdAt},${v.createdAt})`;
  await advance(tx,v.userId,revision);return project(tx,v.userId,v.labelId);
 });}
 async undoCalibrationLabel(input:CalibrationUndoInput):Promise<CalibrationLabelResult>{const v=undoInput.parse(input);return this.db.transaction(async tx=>{
  this.db.reviewExclusions?.assertOwner(v.userId);const owner=await lockUser(tx,v.userId);
  await assertPilotCorrectionLabel(tx,this.db,v.userId,v.labelId);
  const [old]=await tx`SELECT label_id,request_fingerprint=${v.requestFingerprint} AND label_id=${v.labelId} AND request=${json(v.request)}::jsonb AS same FROM calibration_undos WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey}`;
  if(old){if(!old.same)fail('IDEMPOTENCY_CONFLICT');return project(tx,v.userId,old.label_id);}
  const result=await project(tx,v.userId,v.labelId);const assigned=await batchExposure(tx,v.userId,result.exposureId);if(assigned)await assertBatchCollecting(tx,v.userId,assigned.batch_id);if(result.state!=='active')fail('STALE_CALIBRATION_LABEL');if(!result.canUndo)fail('MUTATION_PENDING');if(Date.parse(v.createdAt)<Date.parse(result.updatedAt))fail('STALE_CALIBRATION_LABEL');
  const revision=Number(owner.feedback_revision)+1;
  await tx`INSERT INTO calibration_undos(command_id,user_id,label_id,idempotency_key,request_fingerprint,request,created_at) VALUES(${v.commandId},${v.userId},${v.labelId},${v.request.idempotencyKey},${v.requestFingerprint},${json(v.request)}::jsonb,${v.createdAt})`;
  await tx`UPDATE calibration_labels SET label=NULL,revoked=true,revision=${revision},updated_at=${v.createdAt} WHERE user_id=${v.userId} AND label_id=${v.labelId}`;
  const batch=await batchExposure(tx,v.userId,result.exposureId);if(batch)await tx`UPDATE calibration_batch_items SET status='revoked' WHERE batch_item_id=${batch.batch_item_id}`;
  await advance(tx,v.userId,revision);return project(tx,v.userId,v.labelId);
 });}
 async calibrationHistory(userId:string):Promise<CalibrationHistory>{IdSchema.parse(userId);return this.db.transaction(async tx=>{
  this.db.reviewExclusions?.assertOwner(userId);await lockUser(tx,userId);const items=await projections(tx,userId);
  if(!this.db.reviewExclusions)return CalibrationHistorySchema.parse({items,nextCursor:null});
  const permitted:CalibrationLabelResult[]=[];for(const item of items){try{await assertPilotCorrectionLabel(tx,this.db,userId,item.labelId);permitted.push(item);}catch(error){if(!(error instanceof PersistenceError)||!['CALIBRATION_LABEL_NOT_FOUND','REVIEW_TRACK_EXCLUDED','REVIEW_EXPOSURE_NOT_PUBLISHED'].includes(error.code))throw error;}}
  return CalibrationHistorySchema.parse({items:permitted,nextCursor:null});
 });}
}
