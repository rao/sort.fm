import {PolicyAssociationEventSchema,type ReviewResult} from '@sortfm/contracts';import type {Transaction} from './client';import * as p from './policy-core';
/** Called after idempotency replay lookup, before a NEW review command consumes an exposure. */
export async function assertPolicyExposure(tx:Transaction,userId:string,exposureId:string){
 if(!await p.ready(tx))return;
 const [b]=await tx`SELECT *,expires_at>clock_timestamp() AS live FROM policy_exposure_bindings WHERE user_id=${userId} AND exposure_id=${exposureId}`;
 if(b&&(!b.published||b.closed_at!==null||!b.live))p.fail('POLICY_EXPOSURE_CLOSED');
}
/** Called only from confirmed cleanup settlement, inside its owner transaction. */
export async function settlePolicy(tx:Transaction,userId:string,result:ReviewResult){
 if(!['COMPLETE','UNDONE'].includes(result.status))return;
 const [exposure]=await tx`SELECT payload,purpose FROM exposures WHERE user_id=${userId} AND exposure_id=${result.exposureId}`;
 if(!exposure||exposure.purpose!=='review')p.fail('EXPOSURE_PURPOSE_MISMATCH');
 const adaptive=['linucb','epsilon_greedy'].includes(exposure.payload.exposure.selectionMethod);
 if(!await p.ready(tx)){if(adaptive)p.fail('POLICY_STORAGE_UNAVAILABLE');return;}
 const [binding]=await tx`SELECT b.*,i.draft,i.publication FROM policy_exposure_bindings b JOIN policy_selection_intents i USING(user_id,request_id) WHERE b.user_id=${userId} AND b.exposure_id=${result.exposureId}`;
 if(!binding){if(adaptive)p.fail('POLICY_BINDING_REQUIRED');return;}
 if(!binding.published||binding.track_id!==result.trackId)p.fail('POLICY_EXPOSURE_CONFLICT');
 const reason=result.status==='UNDONE'?'undo':result.action==='SKIP'?'skip':'consumed';
 await tx`UPDATE policy_exposure_bindings SET closed_at=COALESCE(closed_at,clock_timestamp()),closure_reason=${reason} WHERE user_id=${userId} AND exposure_id=${result.exposureId}`;
 if(binding.draft.kind!=='adaptive')return;
 const decision=binding.publication?.policyDecision;if(!decision||decision.exposureId!==result.exposureId||decision.trackId!==result.trackId)p.fail('POLICY_EXPOSURE_CONFLICT');
 const operation=result.status==='UNDONE'?'revoke':'upsert';
 await p.enqueue(tx,binding,result.exposureId,`association:${result.decisionId}:${operation}`,'associate',(eventId,sequence)=>PolicyAssociationEventSchema.parse({eventId,sequence,source:'cleanup',decisionId:result.decisionId,exposureId:result.exposureId,trackId:result.trackId,policyVersion:decision.policyVersion,modelVersion:decision.modelVersion,operation,feedbackRevision:result.feedbackRevision,label:result.label,features:exposure.payload.features,occurredAt:result.updatedAt}));
}
