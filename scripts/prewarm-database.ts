/** Operator-only advisory reader. No queue, provider, model or persistence mutation. */
import {z} from 'zod';
import {IdSchema,TimestampSchema} from '../packages/contracts/src/index';
import type {Database} from '../packages/db/src/client';
import {readLibrary} from '../packages/db/src/repository';
import {PREWARM_LIBRARY_LIMIT,PREWARM_RECENT_EXPOSURE_LIMIT,type PrewarmPriorityPort} from '../apps/api/src/calibration/prewarm';
const querySchema=z.strictObject({since:TimestampSchema,limit:z.number().int().min(1).max(PREWARM_RECENT_EXPOSURE_LIMIT)});
/** `now` must be the same captured timestamp passed to readPrewarmPriority. */
export function createDatabasePrewarmPort(db:Database,now=Date.now()):PrewarmPriorityPort {
 if(!Number.isSafeInteger(now)||now<86400000||now>8640000000000000)throw Error('INVALID_PREWARM_TIME');
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(db.schema))throw Error('INVALID_DATABASE_SCHEMA');
 const asOf=new Date(now).toISOString();
 return {async readPrewarmSnapshot(userId,query){
  IdSchema.parse(userId);const {since,limit}=querySchema.parse(query);
  if(Date.parse(since)>now)throw Error('INVALID_PREWARM_WINDOW');
  // A row lock would require READ WRITE. MVCC gives this advisory read one
  // consistent image without holding up the owner's labeling transaction.
  return db.sql.begin('isolation level repeatable read read only',async tx=>{
   await tx.unsafe(`SET LOCAL search_path TO "${db.schema}", public`);
   const [owner]=await tx`SELECT 1 FROM users WHERE id=${userId}`;
   if(!owner)throw Error('USER_NOT_FOUND');
   const [size]=await tx`SELECT count(*)::int AS rows FROM saved_tracks s WHERE s.user_id=${userId} AND (NOT EXISTS(SELECT 1 FROM library_state WHERE user_id=${userId}) OR EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id))`;
   if(size.rows>PREWARM_LIBRARY_LIMIT)throw Error('PREWARM_LIBRARY_LIMIT_EXCEEDED');
   const library=await readLibrary(tx,userId);
   // Exact eligibility predicate from packages/db/src/calibration.ts:
   // PostgresCalibrationStore.calibrationCandidates (A1 base 7c6eff4).
   // Keep the disposable-DB parity test when D changes this authority.
   const eligible=await tx`SELECT s.track_id FROM saved_tracks s JOIN tracks t USING(track_id) JOIN library_membership m ON m.user_id=s.user_id AND m.track_id=s.track_id LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id LEFT JOIN effective_feedback f ON f.user_id=s.user_id AND f.track_id=s.track_id WHERE s.user_id=${userId} AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true' AND s.current_status IN ('saved','deferred') AND (d.result IS NULL OR d.result->>'status' IN ('UNDONE','FAILED_TERMINAL')) AND (f.label IS NULL OR f.revoked) AND NOT EXISTS(SELECT 1 FROM review_decisions r WHERE r.user_id=s.user_id AND r.track_id=s.track_id AND r.result->>'status' IN ('PENDING','FAILED_RETRYABLE')) AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions r USING(user_id,decision_id) WHERE u.user_id=s.user_id AND r.track_id=s.track_id AND u.settled_at IS NULL) ORDER BY s.track_id`;
   // Consumption survives Undo. Filter it, expired records and future records
   // BEFORE the bound so obsolete commands cannot crowd out recent batches.
   const recent=await tx`SELECT e.exposure_id,e.track_id,e.purpose,e.served_at,(e.payload->'exposure'->>'position')::integer AS position
    FROM exposures e WHERE e.user_id=${userId} AND e.served_at>=${since}::timestamptz AND e.served_at<=${asOf}::timestamptz
    AND ((e.purpose='review' AND NOT EXISTS(SELECT 1 FROM exposure_consumptions c WHERE c.user_id=e.user_id AND c.exposure_id=e.exposure_id))
      OR (e.purpose='calibration' AND NOT EXISTS(SELECT 1 FROM calibration_labels l WHERE l.user_id=e.user_id AND l.exposure_id=e.exposure_id)))
    ORDER BY e.served_at DESC,e.purpose COLLATE "C",position,e.exposure_id LIMIT ${limit}`;
   return {userId,library,eligibleTrackIds:eligible.map((r:any)=>r.track_id),recentExposures:recent.map((r:any)=>({exposureId:r.exposure_id,trackId:r.track_id,purpose:r.purpose,servedAt:new Date(r.served_at).toISOString(),position:r.position,consumed:false}))};
  });
 }};
}
