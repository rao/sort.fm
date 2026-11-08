import type {ReviewExclusionPolicy} from './review-exclusions';
import {type SelectionIntent,type SelectionDraft,type PrepareSelectionInput,type ExposureInput,type PolicyDecision} from '@sortfm/contracts';
import {type Transaction} from './client';import {readReviewCandidates} from './policy-eligibility';import * as p from './policy-core';
export async function reconcile(tx:Transaction,userId:string,policy?:ReviewExclusionPolicy){
 if(policy){policy.assertOwner(userId);const active=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${userId} AND status IN ('prepared','published')`;
  for(const row of active)if(intentExcluded(row,policy)){
   if(row.draft.kind==='adaptive')await p.enqueueRelease(tx,row,row.draft.request.exposureId,'abandoned');
   await tx`UPDATE policy_selection_intents SET status=${row.draft.kind==='adaptive'?'release_pending':'closed'},lease_id=NULL,lease_until=NULL WHERE user_id=${userId} AND request_id=${row.request_id}`;
   await tx`UPDATE policy_exposure_bindings SET closed_at=COALESCE(closed_at,clock_timestamp()),closure_reason=COALESCE(closure_reason,'abandoned') WHERE user_id=${userId} AND request_id=${row.request_id}`;
  }
 }
 const expired=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${userId} AND status IN ('prepared','published') AND expires_at<=clock_timestamp()`;
 for(const row of expired){if(row.draft.kind==='adaptive')await p.enqueueRelease(tx,row,row.draft.request.exposureId,'abandoned');await tx`UPDATE policy_selection_intents SET status=${row.draft.kind==='adaptive'?'release_pending':'expired'},lease_id=NULL,lease_until=NULL WHERE user_id=${userId} AND request_id=${row.request_id}`;}
 await tx`UPDATE policy_exposure_bindings SET closed_at=expires_at,closure_reason='expiry' WHERE user_id=${userId} AND closed_at IS NULL AND expires_at<=clock_timestamp()`;
 await tx`UPDATE policy_exposure_bindings b SET closed_at=clock_timestamp(),closure_reason='consumed' WHERE b.user_id=${userId} AND b.closed_at IS NULL AND EXISTS(SELECT 1 FROM exposure_consumptions c WHERE c.user_id=b.user_id AND c.exposure_id=b.exposure_id)`;
}
export async function project(tx:Transaction,row:any,policy?:ReviewExclusionPolicy):Promise<SelectionIntent>{
 const base=await readReviewCandidates(tx,row.user_id,{ignoreReservations:true,reviewExclusions:policy}),eligible=new Set(base.eligibleTrackIds),at=await p.now(tx);
 const bindings=await tx`SELECT * FROM policy_exposure_bindings WHERE user_id=${row.user_id} AND request_id=${row.request_id} ORDER BY reserved_at,exposure_id`;
 const reservations=bindings.filter((b:any)=>b.published).map((b:any)=>({exposureId:b.exposure_id,trackId:b.track_id,reservedAt:p.iso(b.reserved_at),expiresAt:p.iso(b.expires_at),status:b.closure_reason==='expiry'?'expired' as const:b.closed_at?'closed' as const:'active' as const,closedAt:b.closed_at?p.iso(b.closed_at):null,closureReason:b.closure_reason}));
 const servableExposureIds:string[]=!intentExcluded(row,policy)&&row.status==='published'&&new Date(row.expires_at).getTime()>at?bindings.filter((b:any)=>b.published&&!b.closed_at&&new Date(b.expires_at).getTime()>at&&eligible.has(b.track_id)).map((b:any)=>b.exposure_id):[];
 return {userId:row.user_id,requestId:row.request_id,fingerprint:row.fingerprint,draft:row.draft,feedbackRevision:row.feedback_revision,membershipRevision:row.membership_revision,createdAt:p.iso(row.created_at),expiresAt:p.iso(row.expires_at),status:row.status,lease:row.lease_id&&new Date(row.lease_until).getTime()>at?{leaseId:row.lease_id,leaseUntil:p.iso(row.lease_until)}:null,publication:row.publication?{...row.publication,reservations}:null,replayable:servableExposureIds.length>0,servableExposureIds};
}
export function ids(draft:SelectionDraft){return draft.kind==='c1'?draft.items.map(v=>({exposureId:v.exposure.exposureId,trackId:v.exposure.trackId})):[{exposureId:draft.request.exposureId,trackId:null}];}
export function validateDraft(v:PrepareSelectionInput){
 const tracks=v.draft.kind==='c1'?v.draft.items.map(i=>i.exposure.trackId):v.draft.request.candidates.map(c=>c.trackId);
 if(new Set(tracks).size!==tracks.length||new Set(ids(v.draft).map(i=>i.exposureId)).size!==ids(v.draft).length)p.fail('INVALID_POLICY_INPUT');
 if(v.draft.kind==='c1'){
  if(v.draft.items.some((i,n)=>i.userId!==v.userId||i.exposure.position!==n||!['logistic_rank','deterministic_baseline'].includes(i.exposure.selectionMethod)||i.exposure.policyTelemetry!==undefined))p.fail('INVALID_POLICY_INPUT');
  if(new Set(v.draft.items.map(i=>i.prediction.modelVersion)).size!==1)p.fail('POLICY_EXPOSURE_CONFLICT');
 }else{const r=v.draft.request;if(r.userId!==v.userId||!r.modelVersion||r.feedbackRevision!==v.feedbackRevision||!['linucb','epsilon_greedy'].includes(r.config.strategy))p.fail('INVALID_POLICY_INPUT');}
 return tracks;
}

/** Validate persisted display/analytics provenance against the exact authenticated decision. */
export function validateTelemetry(item:ExposureInput,d:PolicyDecision,providerExpiresAt:string){
 const e=item.exposure,t=e.policyTelemetry,s=d.selection;
 if(!t||e.servedAt!==d.createdAt||e.explorationCoefficient!==d.config.alpha||e.propensityEstimate!==s.propensityEstimate)p.fail('POLICY_EXPOSURE_CONFLICT');
 const {reservation,...actual}=t??p.fail('POLICY_EXPOSURE_CONFLICT');
 const expected={selectionMethod:s.selectionMethod,strategy:s.strategy,policyStateVersion:d.policyStateVersion,contextVersion:d.contextVersion,rewardVersion:d.rewardVersion,modelFeedbackRevision:d.feedbackRevision,predictedReward:s.predictedReward,selectionScore:s.selectionScore,uncertainty:s.uncertainty,explorationBonus:s.explorationBonus,informationGain:s.informationGain,candidateCount:d.candidateCount,availableCount:d.availableCount,eligibleCount:s.eligibleCount,trainedRewards:d.trainedRewards,reasons:s.reasons};
 // Provider timestamps can precede a cached decision after clock rollback. The
 // original bounded deadline remains authoritative and is also capped by D's intent.
 if(!p.same(actual,expected)||reservation.status!=='active'||reservation.reservedAt!==d.createdAt||reservation.expiresAt!==providerExpiresAt)p.fail('POLICY_EXPOSURE_CONFLICT');
}

export function intentExcluded(row:any,policy?:ReviewExclusionPolicy):boolean{
 if(!policy)return false;policy.assertOwner(row.user_id);
 const tracks:string[]=row.draft.kind==='c1'?row.draft.items.map((i:any)=>i.exposure.trackId):row.draft.request.candidates.map((c:any)=>c.trackId);
 return [...tracks,...(row.publication?.items??[]).map((i:any)=>i.exposure.trackId)].some(id=>policy.denies(row.user_id,id));
}
