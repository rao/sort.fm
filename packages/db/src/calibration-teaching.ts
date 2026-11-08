import {IdSchema,TrackCardSchema,FEATURE_VERSION,TeachingStatusSchema,type TeachingStatus,type CalibrationLibraryRow} from '@sortfm/contracts';
import {Database,PersistenceError,type Transaction} from './client';
import {ready as policyReady} from './policy-core';
const unavailable=():never=>{throw new PersistenceError('CALIBRATION_UNAVAILABLE');};

/** Public ordinary Teach cannot prove privacy from a partially installed ledger. */
export async function teachingStorage(tx:Transaction,userId:string){
 const [r]=await tx`SELECT
  (SELECT count(*)::int FROM unnest(ARRAY['users','saved_tracks','library_membership','review_decisions','undo_commands','feedback','calibration_labels','unified_feedback','effective_feedback','exposures','calibration_batches','calibration_batch_items','calibration_batch_exposures','calibration_batch_skips']) n(name) WHERE to_regclass(current_schema()||'.'||name) IS NOT NULL) AS relations,
  (SELECT count(*)::int FROM schema_migrations WHERE name IN ('012_calibration.sql','015_calibration_batch2.sql')) AS migrations,
  EXISTS(SELECT 1 FROM schema_migrations WHERE name='017_calibration_batch3.sql') AS batch3_installed,
  to_regclass(current_schema()||'.calibration_experiments') IS NOT NULL AS batch3_table`;
 if(r.relations!==14||r.migrations!==2||r.batch3_installed!==r.batch3_table)unavailable();
 const policy=await policyReady(tx);
 const [owner]=await tx`SELECT feedback_revision FROM users WHERE id=${userId}`;if(!owner)unavailable();
 // Missing permanent assignments must not silently release an evaluation identity.
 if((await tx`SELECT 1 FROM calibration_batches b WHERE b.user_id=${userId} AND (
  b.experiment NOT IN ('calibration-batch2-v1','calibration-batch3-v1')
  OR jsonb_typeof(b.snapshot->'selected') IS DISTINCT FROM 'array'
  OR CASE WHEN jsonb_typeof(b.snapshot->'selected')='array' THEN
   jsonb_array_length(b.snapshot->'selected')<>CASE WHEN b.experiment='calibration-batch2-v1' THEN 70 ELSE 60 END
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.snapshot->'selected') s WHERE NOT EXISTS(
    SELECT 1 FROM calibration_batch_items i WHERE i.user_id=b.user_id AND i.batch_id=b.batch_id AND i.track_id=s->>'trackId' AND i.assignment=s->>'assignment' AND i.replacement_for IS NULL))
  ELSE false END) LIMIT 1`).length)unavailable();
 if(r.batch3_table){
  if((await tx`SELECT 1 FROM calibration_batches b LEFT JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=${userId} AND b.experiment='calibration-batch3-v1' AND (x.phase IS NULL OR x.phase NOT IN ('reserved','ready') OR (x.phase='ready' AND (x.seal_receipt IS NULL OR x.seal_request IS NULL))) LIMIT 1`).length)unavailable();
 }else if((await tx`SELECT 1 FROM calibration_batches WHERE user_id=${userId} AND experiment='calibration-batch3-v1' LIMIT 1`).length)unavailable();
 return {policy,batch3:Boolean(r.batch3_table),feedbackRevision:Number(owner.feedback_revision)};
}
export async function ordinaryTeachingExclusions(tx:Transaction,userId:string){
 const installed=await teachingStorage(tx,userId);
 const rows=await tx.unsafe(`SELECT track_id FROM unified_feedback WHERE user_id=$1 AND split='holdout'
 UNION SELECT track_id FROM calibration_batch_items WHERE user_id=$1
 UNION SELECT track_id FROM review_decisions WHERE user_id=$1 AND (result IS NULL OR result->>'status' IN ('PENDING','FAILED_RETRYABLE'))
 UNION SELECT d.track_id FROM undo_commands u JOIN review_decisions d USING(user_id,decision_id) WHERE u.user_id=$1 AND u.settled_at IS NULL
 ${installed.policy?`UNION SELECT track_id FROM policy_exposure_bindings WHERE user_id=$1 AND closed_at IS NULL AND expires_at>statement_timestamp()`:''}`,[userId]);
 return new Set<string>(rows.map((r:any)=>r.track_id));
}
/** Filter relational identities before parsing any excluded metadata. */
export async function teachingLibrary(tx:Transaction,db:Database,userId:string,excluded:Set<string>):Promise<CalibrationLibraryRow[]>{
 const rows=await tx`SELECT s.track_id,t.card,s.original_added_at,s.current_status,a.normalized,d.result AS current_decision
  FROM saved_tracks s JOIN tracks t USING(track_id)
  LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id
  LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id
  LEFT JOIN available_audio_features a ON a.track_id=s.track_id AND a.feature_version=${FEATURE_VERSION}
  WHERE s.user_id=${userId} AND (NOT EXISTS(SELECT 1 FROM library_state WHERE user_id=${userId}) OR EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id))
  ORDER BY s.original_added_at,s.track_id`;
 return rows.filter((r:any)=>!excluded.has(r.track_id)&&!db.reviewExclusions?.denies(userId,r.track_id)).map((r:any)=>{
  const track=TrackCardSchema.parse({...r.card,originalAddedAt:new Date(r.original_added_at).toISOString()});
  if(track.trackId!==r.track_id)unavailable();
  return {track,currentStatus:r.current_status,audioFeatures:r.normalized??null,currentDecision:r.current_decision??null};
 });
}
/** Repeatable read gives revision, effective labels and fit receipt one snapshot.
 * No owner FOR UPDATE, transport calls, outbox wakeups or model writes. */
export async function teachingRead<T>(db:Database,userId:string,read:(tx:Transaction)=>Promise<T>):Promise<T>{
 try{IdSchema.parse(userId);db.reviewExclusions?.assertOwner(userId);
  return await db.sql.begin('isolation level repeatable read read only',async tx=>{
   await tx.unsafe(`SET LOCAL search_path TO "${db.schema}", pg_catalog`);
   await tx.unsafe("SET LOCAL statement_timeout='10s'");return read(tx);
  }) as T;
 }catch{return unavailable();}
}
export async function teachingStatus(db:Database,userId:string):Promise<TeachingStatus>{return teachingRead(db,userId,async tx=>{
 const installed=await teachingStorage(tx,userId);
 const rows=await tx.unsafe(`SELECT f.track_id FROM effective_feedback f
 JOIN exposures e ON e.user_id=f.user_id AND e.exposure_id=f.exposure_id
 LEFT JOIN review_decisions d ON d.user_id=f.user_id AND d.decision_id=f.decision_id AND f.source='review'
 WHERE f.user_id=$1 AND f.split='train' AND NOT f.revoked AND f.label IS NOT NULL
  AND e.payload->'features'->>'permittedForTraining'='true'
  AND (f.source='calibration' OR (d.result->>'status'='COMPLETE' AND ((f.label=0 AND d.request->>'action'='KEEP') OR (f.label=1 AND d.request->>'action' IN ('ARCHIVE','UNLIKE')))))
  AND NOT EXISTS(SELECT 1 FROM unified_feedback h WHERE h.user_id=f.user_id AND h.track_id=f.track_id AND h.split='holdout')
  AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=f.user_id AND b.track_id=f.track_id AND (b.assignment='sealed_evaluation' OR b.status<>'labeled'))
  AND NOT EXISTS(SELECT 1 FROM review_decisions p WHERE p.user_id=f.user_id AND p.track_id=f.track_id AND (p.result IS NULL OR p.result->>'status' IN ('PENDING','FAILED_RETRYABLE')))
  AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions ud USING(user_id,decision_id) WHERE u.user_id=f.user_id AND ud.track_id=f.track_id AND u.settled_at IS NULL)
  ${installed.batch3?`AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b JOIN calibration_batches cb USING(user_id,batch_id) JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=f.user_id AND b.track_id=f.track_id AND cb.experiment='calibration-batch3-v1' AND x.phase<>'ready')`:''}
  ${installed.policy?`AND NOT EXISTS(SELECT 1 FROM policy_exposure_bindings p WHERE p.user_id=f.user_id AND p.track_id=f.track_id AND p.closed_at IS NULL AND p.expires_at>statement_timestamp())`:''}`,[userId]);
 const [receipt]=installed.policy?await tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`:[];
 // A legacy queue acknowledgement alone does not identify the model that fitted it.
 return TeachingStatusSchema.parse({trainingFeedbackCount:rows.filter((r:any)=>!db.reviewExclusions?.denies(userId,r.track_id)).length,
  feedbackRevision:installed.feedbackRevision,synchronizedFeedbackRevision:receipt?Number(receipt.feedback_revision):null,modelVersion:receipt?.model_version??null});
});}
