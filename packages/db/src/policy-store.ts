import {z} from 'zod';
import {IdSchema,ExposureInputSchema,PolicyDecisionSchema,TimestampSchema,type PolicyStore,type SelectionIntent,type PublishedSelection,type PrepareSelectionInput,type PrepareSelectionResult,type PublishSelectionInput,type PublishSelectionResult,type ReleaseSelectionInput,type SelectionReleaseReceipt,type ExposureInput} from '@sortfm/contracts';
import {Database,json,type Transaction} from './client';import {readReviewCandidates} from './policy-eligibility';import * as p from './policy-core';import {reconcile,project,ids,validateDraft,validateTelemetry} from './policy-selection';
import {PolicyDeliveryRepository} from './policy-delivery';
export class PostgresPolicyStore extends PolicyDeliveryRepository implements PolicyStore {
 private run<T>(userId:string,work:(tx:Transaction)=>Promise<T>){p.parse(IdSchema,userId);this.db.reviewExclusions?.assertOwner(userId);return p.atomic(this.db,async tx=>{await p.owner(tx,userId);await p.requireReady(tx);await reconcile(tx,userId,this.db.reviewExclusions);return work(tx);});}
 async reviewCandidates(userId:string){return this.run(userId,tx=>readReviewCandidates(tx,userId,{reviewExclusions:this.db.reviewExclusions}));}
 async currentSelection(userId:string){return this.run(userId,async tx=>{const [row]=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${userId} AND publication IS NOT NULL ORDER BY created_at DESC,request_id DESC LIMIT 1`;return row?project(tx,row,this.db.reviewExclusions):null;});}
 async prepareSelection(input:PrepareSelectionInput):Promise<PrepareSelectionResult>{
  const v=p.parse(p.prepare,input) as PrepareSelectionInput,tracks=validateDraft(v),fingerprint=p.digest(v);
  return this.run(v.userId,async tx=>{
   const [old]=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   if(old){if(old.fingerprint!==fingerprint)p.fail('IDEMPOTENCY_CONFLICT');const view=await project(tx,old,this.db.reviewExclusions);
    if(view.replayable)return {outcome:'replay',intent:view as SelectionIntent&{publication:PublishedSelection}};
    if(old.status!=='prepared')return {outcome:'closed',intent:view};if(view.lease)return {outcome:'in_progress',intent:view};
    await tx`UPDATE policy_selection_intents SET lease_id=${crypto.randomUUID()},lease_until=LEAST(expires_at,clock_timestamp()+${v.leaseMs}*interval '1 millisecond'),lease_started_at=clock_timestamp() WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   }else{
    for(const track of tracks)this.db.reviewExclusions?.assertTrack(v.userId,track);
    if((await tx`SELECT 1 FROM policy_selection_intents WHERE user_id=${v.userId} AND status='prepared' AND expires_at>clock_timestamp()`).length)p.fail('POLICY_SELECTION_BUSY');
    const snapshot=await readReviewCandidates(tx,v.userId,{reviewExclusions:this.db.reviewExclusions}),eligible=new Set(snapshot.eligibleTrackIds);
    if(snapshot.feedbackRevision!==v.feedbackRevision||snapshot.membershipRevision!==v.membershipRevision||tracks.some(t=>!eligible.has(t)))p.fail('POLICY_CANDIDATES_CHANGED');
    for(const id of ids(v.draft))if((await tx`SELECT 1 FROM exposures WHERE exposure_id=${id.exposureId} UNION ALL SELECT 1 FROM policy_exposure_bindings WHERE exposure_id=${id.exposureId}`).length)p.fail('POLICY_EXPOSURE_CONFLICT');
    await tx`INSERT INTO policy_selection_intents(user_id,request_id,fingerprint,draft,feedback_revision,membership_revision,expires_at,status,lease_id,lease_until,lease_started_at) VALUES(${v.userId},${v.requestId},${fingerprint},${json(v.draft)}::jsonb,${v.feedbackRevision},${v.membershipRevision},clock_timestamp()+${v.reservationMs}*interval '1 millisecond','prepared',${crypto.randomUUID()},clock_timestamp()+${Math.min(v.leaseMs,v.reservationMs)}*interval '1 millisecond',clock_timestamp())`;
    for(const id of ids(v.draft))await tx`INSERT INTO policy_exposure_bindings(exposure_id,user_id,request_id,track_id,reserved_at,expires_at) SELECT ${id.exposureId},user_id,request_id,${id.trackId},created_at,expires_at FROM policy_selection_intents WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   }
   return {outcome:'claimed',intent:await project(tx,await p.intent(tx,v.userId,v.requestId),this.db.reviewExclusions) as SelectionIntent&{lease:NonNullable<SelectionIntent['lease']>}};
  });
 }
 async publishSelection(input:PublishSelectionInput):Promise<PublishSelectionResult>{
  const v=p.parse(z.discriminatedUnion('kind',[p.fence.extend({kind:z.literal('c1')}),p.fence.extend({kind:z.literal('adaptive'),item:ExposureInputSchema,decision:PolicyDecisionSchema,providerExpiresAt:TimestampSchema})]),input);
  return this.run(v.userId,async tx=>{
   const row=await p.intent(tx,v.userId,v.requestId),view=await project(tx,row,this.db.reviewExclusions);
   if(row.publication){if(row.draft.kind!==v.kind||(v.kind==='adaptive'&&(!p.same(row.publication.policyDecision,v.decision)||!p.same(row.publication.items,[v.item]))))p.fail('POLICY_EXPOSURE_CONFLICT');return view.replayable?{outcome:'replay',intent:view as SelectionIntent&{publication:PublishedSelection}}:{outcome:'rejected',reason:'closed',intent:view};}
   if(row.status!=='prepared')return {outcome:'rejected',reason:new Date(row.expires_at).getTime()<=await p.now(tx)?'expired':'closed',intent:view};
   if(!view.lease||view.lease.leaseId!==v.leaseId)return {outcome:'rejected',reason:'lease_lost',intent:view};
   if(row.draft.kind!==v.kind)p.fail('POLICY_EXPOSURE_CONFLICT');
   let items:ExposureInput[]=row.draft.items,decision=null,expiry=new Date(row.expires_at).getTime();
   if(v.kind==='adaptive'){
    const r=row.draft.request,d=v.decision,c=r.candidates.find((c:any)=>c.trackId===d.trackId),i=v.item;
    const cold=d.trainedRewards===0&&d.selection.selectionMethod==='c1',expectedMethod=cold?(d.prediction.removalProbability===null?'deterministic_baseline':'logistic_rank'):r.config.strategy;
    if(!c||d.userId!==v.userId||d.exposureId!==r.exposureId||i.userId!==v.userId||i.exposure.exposureId!==d.exposureId||i.exposure.trackId!==d.trackId||i.exposure.policy!==row.draft.queuePolicy||i.exposure.position!==0||i.exposure.policyVersion!==d.policyVersion||i.exposure.selectionMethod!==expectedMethod||(!cold&&d.selection.selectionMethod!==r.config.strategy)||d.modelVersion!==r.modelVersion||d.feedbackRevision!==r.feedbackRevision||d.seed!==r.seed||!p.same(d.config,r.config)||!p.same(d.candidate,c)||!p.same(i.features,c.features)||!p.same(i.prediction,d.prediction)||!p.same([...d.candidateTrackIds].sort(),r.candidates.map((c:any)=>c.trackId).sort()))p.fail('POLICY_EXPOSURE_CONFLICT');
    if(!p.same(i.listeningContext,row.draft.listeningContext))p.fail('POLICY_EXPOSURE_CONFLICT');
    validateTelemetry(i,d,v.providerExpiresAt);
    const remoteEnd=Date.parse(v.providerExpiresAt),start=Date.parse(d.createdAt);if(remoteEnd-start<30000||remoteEnd-start>900000)p.fail('POLICY_EXPOSURE_CONFLICT');
    expiry=Math.min(expiry,remoteEnd);items=[i];decision=d;
   }
   const snapshot=await readReviewCandidates(tx,v.userId,{ignoreRequestId:v.requestId,reviewExclusions:this.db.reviewExclusions}),eligible=new Set(snapshot.eligibleTrackIds),at=await p.now(tx);
   const reason=expiry<=at?'expired':snapshot.feedbackRevision!==row.feedback_revision||snapshot.membershipRevision!==row.membership_revision||items.some(i=>!eligible.has(i.exposure.trackId))?'candidates_changed':null;
   if(reason){if(v.kind==='adaptive')await p.enqueueRelease(tx,row,row.draft.request.exposureId,'abandoned');await tx`UPDATE policy_selection_intents SET status=${v.kind==='adaptive'?'release_pending':reason==='expired'?'expired':'closed'},lease_id=NULL,lease_until=NULL WHERE user_id=${v.userId} AND request_id=${v.requestId}`;await tx`UPDATE policy_exposure_bindings SET closed_at=clock_timestamp(),closure_reason='abandoned' WHERE user_id=${v.userId} AND request_id=${v.requestId} AND closed_at IS NULL`;return {outcome:'rejected',reason,intent:await project(tx,await p.intent(tx,v.userId,v.requestId),this.db.reviewExclusions)};}
   for(const i of items){await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${i.exposure.exposureId},${v.userId},${i.exposure.trackId},${json(i)}::jsonb,${i.exposure.servedAt},'review')`;await tx`UPDATE policy_exposure_bindings SET track_id=${i.exposure.trackId},published=true,expires_at=${new Date(expiry).toISOString()} WHERE user_id=${v.userId} AND exposure_id=${i.exposure.exposureId}`;}
   const publication={items,policyDecision:decision,publishedAt:new Date(at).toISOString(),reservations:[]};await tx`UPDATE policy_selection_intents SET publication=${json(publication)}::jsonb,status='published',lease_id=NULL,lease_until=NULL WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   return {outcome:'published',intent:await project(tx,await p.intent(tx,v.userId,v.requestId),this.db.reviewExclusions) as SelectionIntent&{publication:PublishedSelection}};
  });
 }
 async claimSelectionRecovery(input:{workerId:string;leaseMs:number}):Promise<SelectionIntent|null>{
  const v=p.parse(p.claim,input);return p.atomic(this.db,async tx=>{await p.requireReady(tx);
   const [u]=await tx`SELECT u.id FROM users u WHERE (${this.db.reviewExclusions?.ownerId??null}::text IS NULL OR u.id=${this.db.reviewExclusions?.ownerId??null}) AND EXISTS(SELECT 1 FROM policy_selection_intents i WHERE i.user_id=u.id AND i.status='prepared' AND (i.lease_until<=clock_timestamp() OR i.lease_until IS NULL)) ORDER BY u.id FOR UPDATE OF u SKIP LOCKED LIMIT 1`;if(!u)return null;await reconcile(tx,u.id,this.db.reviewExclusions);
   const [row]=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${u.id} AND status='prepared' AND expires_at>clock_timestamp() AND (lease_until<=clock_timestamp() OR lease_until IS NULL) ORDER BY created_at,request_id LIMIT 1`;if(!row)return null;
   await tx`UPDATE policy_selection_intents SET lease_id=${crypto.randomUUID()},lease_until=LEAST(expires_at,clock_timestamp()+${v.leaseMs}*interval '1 millisecond'),lease_started_at=clock_timestamp() WHERE user_id=${u.id} AND request_id=${row.request_id}`;return project(tx,await p.intent(tx,u.id,row.request_id),this.db.reviewExclusions);
  });
 }
 async releaseSelection(input:ReleaseSelectionInput):Promise<SelectionReleaseReceipt>{
  const v=p.parse(p.release,input);if(new Set(v.exposureIds).size!==v.exposureIds.length)p.fail('INVALID_POLICY_INPUT');const fingerprint=p.digest({...v,exposureIds:[...v.exposureIds].sort()});
  return this.run(v.userId,async tx=>{
   const [old]=await tx`SELECT fingerprint,receipt FROM policy_release_commands WHERE user_id=${v.userId} AND release_id=${v.releaseId}`;if(old){if(old.fingerprint!==fingerprint)p.fail('IDEMPOTENCY_CONFLICT');return old.receipt;}
   const row=await p.intent(tx,v.userId,v.requestId),view=await project(tx,row,this.db.reviewExclusions);
   if(v.expectedLeaseId!==undefined&&(!view.lease||view.lease.leaseId!==v.expectedLeaseId||row.status!=='prepared'))p.fail('POLICY_LEASE_LOST');
   const bindings=await tx`SELECT * FROM policy_exposure_bindings WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   if(v.exposureIds.some(id=>!bindings.some((b:any)=>b.exposure_id===id)))p.fail('POLICY_EXPOSURE_CONFLICT');
   for(const id of v.exposureIds){await tx`UPDATE policy_exposure_bindings SET closed_at=clock_timestamp(),closure_reason=${v.reason} WHERE user_id=${v.userId} AND exposure_id=${id} AND closed_at IS NULL`;await p.enqueueRelease(tx,row,id,v.reason);}
   const active=(await tx`SELECT 1 FROM policy_exposure_bindings WHERE user_id=${v.userId} AND request_id=${v.requestId} AND closed_at IS NULL AND expires_at>clock_timestamp()`).length;
   if(!active)await tx`UPDATE policy_selection_intents SET status=${row.draft.kind==='adaptive'?'release_pending':'closed'},lease_id=NULL,lease_until=NULL WHERE user_id=${v.userId} AND request_id=${v.requestId}`;
   const receipt:SelectionReleaseReceipt={userId:v.userId,releaseId:v.releaseId,requestId:v.requestId,exposureIds:v.exposureIds,reason:v.reason,recordedAt:new Date(await p.now(tx)).toISOString(),outcome:row.draft.kind==='adaptive'?'release_pending':'closed'};
   await tx`INSERT INTO policy_release_commands(user_id,release_id,request_id,fingerprint,receipt) VALUES(${v.userId},${v.releaseId},${v.requestId},${fingerprint},${json(receipt)}::jsonb)`;return receipt;
  });
 }
}
