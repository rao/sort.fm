import type {ReviewExclusionPolicy} from './review-exclusions';
import {IdSchema} from '@sortfm/contracts';
import type {Transaction} from './client';
import {lockUser,readLibrary} from './repository';
import {reservedCalibrationTrackIds} from './calibration-reservations';
import {ready,fitReceipt} from './policy-core';

/** Shared internal snapshot. Callers keep this transaction open for publication checks. */
export async function readReviewCandidates(tx:Transaction,userId:string,options:{ignoreRequestId?:string;ignoreReservations?:boolean;reviewExclusions?:ReviewExclusionPolicy}={}){
 options.reviewExclusions?.assertOwner(userId);IdSchema.parse(userId);await lockUser(tx,userId);
 const [revision]=await tx`SELECT feedback_revision,membership_revision FROM users WHERE id=${userId}`;
 const confirmed=(await tx`SELECT 1 FROM library_state WHERE user_id=${userId}`).length>0;
 const library=confirmed?await readLibrary(tx,userId):[];
 const reserved=new Set(await reservedCalibrationTrackIds(tx,userId));
 const rows=await tx`
  SELECT s.track_id FROM saved_tracks s JOIN tracks t USING(track_id)
  JOIN library_state state ON state.user_id=s.user_id
  JOIN library_membership m ON m.user_id=s.user_id AND m.track_id=s.track_id
  LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id
  LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id
  WHERE s.user_id=${userId} AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true'
   AND s.current_status IN ('saved','deferred')
   AND (d.result IS NULL OR d.result->>'status' IN ('UNDONE','FAILED_TERMINAL')
        OR (d.result->>'status'='COMPLETE' AND d.result->>'action'='SKIP'))
   AND NOT EXISTS(SELECT 1 FROM review_decisions pending WHERE pending.user_id=s.user_id
      AND pending.track_id=s.track_id AND pending.result->>'status' IN ('PENDING','FAILED_RETRYABLE'))
   AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions ud USING(user_id,decision_id)
      WHERE u.user_id=s.user_id AND ud.track_id=s.track_id AND u.settled_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM effective_feedback f WHERE f.user_id=s.user_id AND f.track_id=s.track_id
      AND f.label IS NOT NULL AND NOT f.revoked)
  ORDER BY s.original_added_at,s.track_id`;
 const eligibleTrackIds:string[]=rows.map((r:any)=>r.track_id as string);
 const base=eligibleTrackIds.filter(id=>!reserved.has(id)&&!options.reviewExclusions?.denies(userId,id)),installed=await ready(tx);
 const queue=new Set<string>(installed&&!options.ignoreReservations?(await tx`SELECT track_id FROM policy_exposure_bindings WHERE user_id=${userId} AND track_id IS NOT NULL AND closed_at IS NULL AND expires_at>clock_timestamp() AND (${options.ignoreRequestId??null}::uuid IS NULL OR request_id<>${options.ignoreRequestId??null}::uuid)`).map((r:any)=>r.track_id):[]);
 return {library,eligibleTrackIds:base.filter(id=>!queue.has(id)),remaining:base.length,fitReceipt:installed?await fitReceipt(tx,userId):null,
  feedbackRevision:Number(revision.feedback_revision),membershipRevision:Number(revision.membership_revision)};
}
