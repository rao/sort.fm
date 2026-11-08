import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ExposureInputSchema,PolicyExposureSchema,type PolicyStore,type SelectionIntent,type PublishSelectionResult} from '@sortfm/contracts';
import {validatePolicyDecision,type PolicyClient} from '../../ml/client';

/** Bounds an entire selection attempt, including its inspection, without retrying. */
export async function bounded<T>(operation:()=>Promise<T>,timeoutMs:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([operation(),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('POLICY_SELECTION_TIMEOUT')),timeoutMs);
  })]);} finally {clearTimeout(timer);}
}

/** Network work completes before any publish. Late timed-out results cannot publish. */
export async function publishAdaptive(
  store:Pick<PolicyStore,'publishSelection'>,client:Pick<PolicyClient,'select'|'exposure'>,
  intent:SelectionIntent,now:()=>number,timeoutMs:number,
):Promise<PublishSelectionResult> {
  if(intent.draft.kind!=='adaptive'||!intent.lease||intent.status!=='prepared'
    ||Date.parse(intent.expiresAt)<=now())throw new Error('POLICY_INTENT_UNAVAILABLE');
  const leaseId=intent.lease.leaseId;
  const deadline=performance.now()+timeoutMs;
  const {request,queuePolicy}=intent.draft;
  if(request.userId!==intent.userId)throw new Error('POLICY_OWNER_MISMATCH');
  const {decision,inspection}=await bounded(async()=>{
    const decision=validatePolicyDecision(request,await client.select(structuredClone(request)));
    const inspection=PolicyExposureSchema.parse(await client.exposure({userId:intent.userId,exposureId:request.exposureId}));
    return {decision,inspection};
  },timeoutMs);
  const reservation=inspection.reservation;
  if(!isDeepStrictEqual(inspection.decision,decision)||reservation.exposureId!==request.exposureId
    ||reservation.status!=='active'||Date.parse(reservation.expiresAt)<=now()
    ||Date.parse(intent.expiresAt)<=now())throw new Error('POLICY_RESERVATION_UNAVAILABLE');
  const selection=decision.selection,prediction=decision.prediction;
  const item=ExposureInputSchema.parse({userId:intent.userId,features:decision.candidate.features,prediction,
    exposure:{exposureId:decision.exposureId,trackId:decision.trackId,policy:queuePolicy,
      selectionMethod:selection.selectionMethod==='c1'
        ? (prediction.removalProbability===null?'deterministic_baseline':'logistic_rank'):selection.selectionMethod,
      policyVersion:decision.policyVersion,explorationCoefficient:decision.config.alpha,
      propensityEstimate:selection.propensityEstimate,modelVersion:decision.modelVersion,featureVersion:decision.featureVersion,
      removalScore:prediction.removalProbability,heuristicScore:prediction.heuristicScore,uncertainty:prediction.uncertainty,
      position:0,servedAt:decision.createdAt,
      policyTelemetry:{selectionMethod:selection.selectionMethod,strategy:selection.strategy,policyStateVersion:decision.policyStateVersion,
        contextVersion:decision.contextVersion,rewardVersion:decision.rewardVersion,modelFeedbackRevision:decision.feedbackRevision,
        predictedReward:selection.predictedReward,selectionScore:selection.selectionScore,uncertainty:selection.uncertainty,
        explorationBonus:selection.explorationBonus,informationGain:selection.informationGain,candidateCount:decision.candidateCount,
        availableCount:decision.availableCount,eligibleCount:selection.eligibleCount,trainedRewards:decision.trainedRewards,
        reasons:selection.reasons,reservation:{reservedAt:reservation.reservedAt,expiresAt:reservation.expiresAt,
          evaluatedAt:reservation.evaluatedAt,status:reservation.status,closedAt:reservation.closedAt,closureReason:reservation.closureReason}},
    }});
  const remaining=deadline-performance.now();
  if(remaining<=0)throw new Error('POLICY_SELECTION_TIMEOUT');
  return bounded(()=>store.publishSelection({userId:intent.userId,requestId:intent.requestId,leaseId,
    kind:'adaptive',item,decision,providerExpiresAt:reservation.expiresAt}),remaining);
}

/** Stable internal command identity; all semantic changes get a different UUID. */
export function releaseIdentity(intent:SelectionIntent,reason:string):string {
  const hex=createHash('sha256').update(JSON.stringify(['sortfm:policy-release:v1',intent.userId,intent.requestId,reason])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function abandonSelection(store:Pick<PolicyStore,'releaseSelection'>,intent:SelectionIntent):Promise<void> {
  if(!intent.lease)return;
  const exposureIds=intent.draft.kind==='adaptive'?[intent.draft.request.exposureId]:intent.draft.items.map(i=>i.exposure.exposureId);
  await store.releaseSelection({userId:intent.userId,requestId:intent.requestId,expectedLeaseId:intent.lease.leaseId,
    releaseId:releaseIdentity(intent,`abandoned:${intent.lease.leaseId}`),exposureIds,reason:'abandoned'});
}
