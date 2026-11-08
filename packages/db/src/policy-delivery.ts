import {z} from 'zod';import {IdSchema,UuidSchema,TimestampSchema,PolicyAssociationReceiptSchema,PolicyReleaseReceiptSchema,type PolicyDeliveryLease,type PolicyDeliveryAck} from '@sortfm/contracts';
import {Database,json,type Transaction} from './client';import * as p from './policy-core';
// Fixed cross-clock tolerance; never extends the DB-authoritative grace or lease.
const ABSENCE_CLOCK_SKEW_MS=500;
const ackSchema=z.discriminatedUnion('kind',[
 z.strictObject({userId:IdSchema,eventId:UuidSchema,leaseId:UuidSchema,kind:z.literal('associate'),receipt:PolicyAssociationReceiptSchema}),
 z.strictObject({userId:IdSchema,eventId:UuidSchema,leaseId:UuidSchema,kind:z.literal('release'),receipt:PolicyReleaseReceiptSchema}),
 z.strictObject({userId:IdSchema,eventId:UuidSchema,leaseId:UuidSchema,kind:z.literal('release_absent'),exposureId:UuidSchema,checkedAt:TimestampSchema,providerStatus:z.literal(404)}),
]);
async function leased(tx:Transaction,userId:string,eventId:string,leaseId:string){return (await tx`SELECT * FROM policy_delivery_events WHERE user_id=${userId} AND event_id=${eventId} AND lease_id=${leaseId} AND lease_until>clock_timestamp() AND completed_at IS NULL`)[0]??null;}
export class PolicyDeliveryRepository {
 constructor(readonly db:Database){}
 async claimPolicyDelivery(input:{workerId:string;leaseMs:number}):Promise<PolicyDeliveryLease|null>{
  const v=p.parse(p.claim,input);return p.atomic(this.db,async tx=>{await p.requireReady(tx);
   const [u]=await tx`SELECT u.id FROM users u WHERE EXISTS(SELECT 1 FROM policy_delivery_events e LEFT JOIN policy_fit_receipts f ON f.user_id=e.user_id WHERE e.user_id=u.id AND e.completed_at IS NULL AND e.available_at<=clock_timestamp() AND (e.lease_id IS NULL OR e.lease_until<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM policy_delivery_events older WHERE older.user_id=e.user_id AND older.sequence<e.sequence AND older.completed_at IS NULL) AND (e.kind='release' OR f.feedback_revision>=(e.payload->>'feedbackRevision')::integer)) ORDER BY u.id FOR UPDATE OF u SKIP LOCKED LIMIT 1`;
   if(!u)return null;
   const [row]=await tx`SELECT * FROM policy_delivery_events WHERE user_id=${u.id} AND completed_at IS NULL ORDER BY sequence LIMIT 1`;
   const at=await p.now(tx);if(!row||new Date(row.available_at).getTime()>at||(row.lease_id&&new Date(row.lease_until).getTime()>at))return null;
   const receipt=row.kind==='associate'?await p.fitReceipt(tx,u.id):null;if(row.kind==='associate'&&(!receipt||receipt.synchronizedFeedbackRevision<row.payload.feedbackRevision))return null;
   const leaseId=crypto.randomUUID();const [updated]=await tx`UPDATE policy_delivery_events SET lease_id=${leaseId},lease_started_at=clock_timestamp(),lease_until=clock_timestamp()+${v.leaseMs}*interval '1 millisecond',worker_id=${v.workerId},attempts=attempts+1,claimed_fit_receipt=${json(receipt)}::jsonb WHERE event_id=${row.event_id} RETURNING *`;
   return {event:p.delivery(updated),leaseId,leaseUntil:p.iso(updated.lease_until),attempts:updated.attempts,fitReceipt:receipt};
  });
 }
 async acknowledgePolicyDelivery(input:PolicyDeliveryAck):Promise<boolean>{
  const v=p.parse(ackSchema,input);return p.atomic(this.db,async tx=>{await p.owner(tx,v.userId);await p.requireReady(tx);const row=await leased(tx,v.userId,v.eventId,v.leaseId);if(!row)return false;
   const intent=await p.intent(tx,v.userId,row.request_id),[binding]=await tx`SELECT * FROM policy_exposure_bindings WHERE user_id=${v.userId} AND exposure_id=${row.exposure_id}`;
   if(v.kind==='associate'){
    const r=v.receipt;if(row.kind!=='associate'||r.userId!==v.userId||r.eventId!==row.event_id||r.sequence!==Number(row.sequence)||!p.same(r.fitReceipt,row.claimed_fit_receipt)||r.fitReceipt.synchronizedFeedbackRevision<row.payload.feedbackRevision||(r.eligibleForLearning&&(row.payload.operation!=='upsert'||row.payload.label===null||!row.payload.features.permittedForTraining)))p.fail('POLICY_RECEIPT_MISMATCH');
   }else if(v.kind==='release'){
    const r=v.receipt;if(row.kind!=='release'||r.userId!==v.userId||r.requestId!==row.payload.requestId||r.exposureId!==row.exposure_id||(binding.track_id!==null&&r.trackId!==binding.track_id)||Date.parse(r.effectiveClosedAt)>Date.parse(r.expiresAt)||(r.outcome==='released'&&Date.parse(r.effectiveClosedAt)>Date.parse(r.recordedAt)))p.fail('POLICY_RECEIPT_MISMATCH');
   }else{
    const at=await p.now(tx),checked=Date.parse(v.checkedAt),started=new Date(row.lease_started_at).getTime(),graceAt=new Date(intent.expires_at).getTime()+60000;
    // A pre-grace claim must be retried under a fresh lease. Preserve checkedAt
    // verbatim in the receipt; tolerate clock skew without inventing proof time.
    if(row.kind!=='release'||v.exposureId!==row.exposure_id||intent.draft.kind!=='adaptive'||intent.publication!==null||binding.published||started<graceAt||at<graceAt||at<started||checked<started-ABSENCE_CLOCK_SKEW_MS||checked>at+ABSENCE_CLOCK_SKEW_MS)p.fail('POLICY_RECEIPT_MISMATCH');
   }
   const absence=v.kind==='release_absent';await tx`UPDATE policy_delivery_events SET completed_at=clock_timestamp(),disposition=${absence?'absent_after_deadline':'acknowledged'},receipt=${json(absence?v:v.receipt)}::jsonb,lease_id=NULL,lease_until=NULL,worker_id=NULL,error_code=NULL WHERE event_id=${row.event_id}`;
   if(row.kind==='release')await tx`UPDATE policy_selection_intents SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'closed' END,lease_id=NULL,lease_until=NULL WHERE user_id=${v.userId} AND request_id=${row.request_id} AND status='release_pending'`;
   return true;
  });
 }
 async retryPolicyDelivery(input:{userId:string;eventId:string;leaseId:string;retryAt:string;errorCode:string}):Promise<boolean>{
  const v=p.parse(p.retry,input);return p.atomic(this.db,async tx=>{await p.owner(tx,v.userId);await p.requireReady(tx);const row=await leased(tx,v.userId,v.eventId,v.leaseId);if(!row)return false;
   const at=await p.now(tx),backoff=Math.min(60000,250*2**Math.min(8,row.attempts-1)),available=Math.min(at+300000,Math.max(at+backoff+Math.floor(Math.random()*250),Date.parse(v.retryAt)));
   await tx`UPDATE policy_delivery_events SET available_at=${new Date(available).toISOString()},lease_id=NULL,lease_until=NULL,worker_id=NULL,error_code=${v.errorCode} WHERE event_id=${v.eventId}`;return true;
  });
 }
}
