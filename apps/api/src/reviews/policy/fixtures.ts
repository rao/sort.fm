/** Synthetic transport fixtures; never production state or real listener data. */
import {FEATURE_VERSION,PolicyConfigSchema,type PolicySelectRequest,type PolicyDecision,type PolicyExposure} from '@sortfm/contracts';
export const policyAt='2026-11-07T12:00:00Z';
export const policyRequest:PolicySelectRequest={userId:'demo:policy-owner',featureVersion:FEATURE_VERSION,
  exposureId:'10000000-0000-4000-8000-000000000010',modelVersion:'test:c1:r3',feedbackRevision:3,seed:42,
  config:PolicyConfigSchema.parse({strategy:'linucb'}),candidates:[{trackId:'demo:track',artistIds:['demo:artist'],
    features:{featureVersion:FEATURE_VERSION,provenance:'synthetic',permittedForTraining:true,values:{duration_ms:120000}}}],
};
export const policyDecision:PolicyDecision={userId:policyRequest.userId,exposureId:policyRequest.exposureId,
  trackId:'demo:track',candidate:policyRequest.candidates[0]!,
  prediction:{modelKind:'logistic',modelVersion:'test:c1:r3',featureVersion:FEATURE_VERSION,trainedExamples:12,
    removalProbability:0.6,heuristicScore:null,uncertainty:0.7,uncertaintyMethod:'entropy',calibrated:false,explanations:[]},
  modelVersion:'test:c1:r3',featureVersion:FEATURE_VERSION,feedbackRevision:3,policyVersion:'test:policy:v1',
  policyStateVersion:'test:policy:state',contextVersion:'test:context:v1',rewardVersion:'test:reward:v1',seed:42,step:1,
  config:policyRequest.config,selection:{index:0,trackId:'demo:track',strategy:'exploit',selectionMethod:'linucb',
    predictedReward:1.2,baselineScore:0.6,selectionScore:1.8,uncertainty:1.4,explorationBonus:0.6,informationGain:0.5,
    propensityEstimate:null,greedyTrackId:'demo:track',eligibleCount:1,explorationAllowed:false,reasons:[],context:[1,0.6]},
  candidateSetHash:'a'.repeat(64),candidateTrackIds:['demo:track'],candidateCount:1,availableCount:1,
  contextNames:['bias','probability'],trainedRewards:3,rankedTrackIds:null,createdAt:policyAt,
};
export const policyInspection:PolicyExposure={decision:policyDecision,feedback:[],eligibility:null,
  reservation:{exposureId:policyDecision.exposureId,reservedAt:policyAt,expiresAt:'2026-11-07T12:05:00Z',
    evaluatedAt:policyAt,status:'active',closedAt:null,closureReason:null}};
