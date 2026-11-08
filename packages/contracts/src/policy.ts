/** Internal C2 transport. Authentication and owner derivation belong to the API. */
import {z} from 'zod';
import {CandidateSchema,FeatureVectorSchema} from './features';
import {CountSchema,FEATURE_VERSION,IdSchema,PolicyReservationSnapshotSchema,PredictionSchema,ProbabilitySchema,TimestampSchema,UuidSchema} from './schemas';

const count=CountSchema.max(Number.MAX_SAFE_INTEGER);
const version=z.string().min(1);
export const PolicyConfigSchema=z.strictObject({
 strategy:z.enum(['linucb','epsilon_greedy','c1','random']).default('linucb'),
 alpha:z.number().min(0).max(10).default(0.5),ridge:z.number().min(0.001).max(1000).default(1),epsilon:ProbabilitySchema.default(0.1),
 maxExplorationFraction:ProbabilitySchema.default(0.25),diversityWindow:count.max(100).default(5),maxPerArtist:count.min(1).max(100).default(2),obviousKeepThreshold:ProbabilitySchema.default(0.1),
});
export type PolicyConfig=z.infer<typeof PolicyConfigSchema>;
export const PolicyCandidateSchema=CandidateSchema.extend({artistIds:z.array(IdSchema).max(20).default([])});
export type PolicyCandidate=z.infer<typeof PolicyCandidateSchema>;
export const PolicySelectRequestSchema=z.strictObject({
 userId:IdSchema,featureVersion:z.literal(FEATURE_VERSION),exposureId:UuidSchema,
 candidates:z.array(PolicyCandidateSchema).min(1).max(10000),modelVersion:version.nullable().default(null),
 feedbackRevision:count.optional(),seed:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(42),config:PolicyConfigSchema.default(()=>PolicyConfigSchema.parse({})),
}).superRefine((r,ctx)=>{if(new Set(r.candidates.map(c=>c.trackId)).size!==r.candidates.length)ctx.addIssue({code:'custom',message:'Policy candidates require unique track identities'});});
export type PolicySelectRequest=z.infer<typeof PolicySelectRequestSchema>;
export const PolicySelectionSchema=z.strictObject({
 index:count,trackId:IdSchema,strategy:z.enum(['explore','exploit']),selectionMethod:z.enum(['linucb','epsilon_greedy','c1','random']),
 predictedReward:z.number(),baselineScore:ProbabilitySchema,selectionScore:z.number(),uncertainty:z.number().nonnegative(),explorationBonus:z.number().nonnegative(),informationGain:z.number().nonnegative(),
 propensityEstimate:ProbabilitySchema.nullable(),greedyTrackId:IdSchema,eligibleCount:count,explorationAllowed:z.boolean(),reasons:z.array(z.string()),context:z.array(z.number()),
});
export const PolicyDecisionSchema=z.strictObject({
 userId:IdSchema,exposureId:UuidSchema,trackId:IdSchema,candidate:PolicyCandidateSchema,prediction:PredictionSchema,
 modelVersion:version,featureVersion:z.literal(FEATURE_VERSION),feedbackRevision:count.nullable().optional(),
 policyVersion:version,policyStateVersion:version,contextVersion:version,rewardVersion:version,seed:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),step:count,config:PolicyConfigSchema,selection:PolicySelectionSchema,
 candidateSetHash:z.string().regex(/^[a-f0-9]{64}$/),candidateTrackIds:z.array(IdSchema),candidateCount:count,availableCount:count,contextNames:z.array(z.string()),trainedRewards:count,rankedTrackIds:z.array(IdSchema).nullable(),createdAt:TimestampSchema,
}).superRefine((r,ctx)=>{
 if(r.trackId!==r.candidate.trackId||r.trackId!==r.selection.trackId||r.modelVersion!==r.prediction.modelVersion||r.featureVersion!==r.prediction.featureVersion||r.selection.eligibleCount>r.availableCount||r.availableCount>r.candidateCount||r.candidateCount!==r.candidateTrackIds.length||new Set(r.candidateTrackIds).size!==r.candidateCount||!r.candidateTrackIds.includes(r.trackId))ctx.addIssue({code:'custom',message:'Policy decision identity and candidate counts must agree'});
});
export type PolicyDecision=z.infer<typeof PolicyDecisionSchema>;

/** An actual successful C1 fit, never a guessed model name or numeric-only acknowledgement. */
export const PolicyFitReceiptSchema=z.strictObject({modelVersion:version,synchronizedFeedbackRevision:count});
export type PolicyFitReceipt=z.infer<typeof PolicyFitReceiptSchema>;
export const PolicyAssociationEventSchema=z.strictObject({
 eventId:UuidSchema,sequence:count.min(1),source:z.literal('cleanup'),decisionId:UuidSchema,exposureId:UuidSchema,trackId:IdSchema,
 policyVersion:version,modelVersion:version,operation:z.enum(['upsert','revoke']),feedbackRevision:count,
 label:z.union([z.literal(0),z.literal(1)]).nullable(),features:FeatureVectorSchema,occurredAt:TimestampSchema,usefulness:ProbabilitySchema.optional(),
}).superRefine((e,ctx)=>{
 if(e.operation==='revoke'&&e.label!==null)ctx.addIssue({code:'custom',message:'Revoke has no label'});
 if(e.usefulness!==undefined&&(e.operation!=='upsert'||e.label===null))ctx.addIssue({code:'custom',message:'Only a strong committed review can carry usefulness'});
});
export type PolicyAssociationEvent=z.infer<typeof PolicyAssociationEventSchema>;
export const PolicyAssociationRequestSchema=z.strictObject({userId:IdSchema,event:PolicyAssociationEventSchema,fitReceipt:PolicyFitReceiptSchema}).superRefine((r,ctx)=>{
 if(r.fitReceipt.synchronizedFeedbackRevision<r.event.feedbackRevision)ctx.addIssue({code:'custom',message:'The C1 fit receipt must cover the committed event revision'});
});
export type PolicyAssociationRequest=z.infer<typeof PolicyAssociationRequestSchema>;
export const PolicyAssociationReceiptSchema=z.strictObject({userId:IdSchema,eventId:UuidSchema,sequence:count.min(1),recordedAt:TimestampSchema,duplicate:z.boolean(),fitReceipt:PolicyFitReceiptSchema,eligibleForLearning:z.boolean()});
export type PolicyAssociationReceipt=z.infer<typeof PolicyAssociationReceiptSchema>;

export const PolicyReleaseRequestSchema=z.strictObject({userId:IdSchema,requestId:UuidSchema,exposureId:UuidSchema,reason:z.enum(['skip','abandoned','prefetch_discarded'])});
export type PolicyReleaseRequest=z.infer<typeof PolicyReleaseRequestSchema>;
export const PolicyReleaseReceiptSchema=z.strictObject({userId:IdSchema,requestId:UuidSchema,exposureId:UuidSchema,trackId:IdSchema,outcome:z.enum(['released','already_closed']),recordedAt:TimestampSchema,expiresAt:TimestampSchema,effectiveClosedAt:TimestampSchema});
export type PolicyReleaseReceipt=z.infer<typeof PolicyReleaseReceiptSchema>;
export const PolicyExposureQuerySchema=z.strictObject({userId:IdSchema,exposureId:UuidSchema});
export const PolicyEligibilitySchema=z.strictObject({evaluatedAt:TimestampSchema,filteringApplied:z.boolean(),exclusions:z.array(z.strictObject({trackId:IdSchema,blockingExposureIds:z.array(UuidSchema),completedReview:z.boolean()}))});
export const PolicyExposureSchema=z.strictObject({decision:PolicyDecisionSchema,feedback:z.array(z.record(z.string(),z.unknown())),reservation:PolicyReservationSnapshotSchema.safeExtend({exposureId:UuidSchema}),eligibility:PolicyEligibilitySchema.nullable()});
export type PolicyExposure=z.infer<typeof PolicyExposureSchema>;
export const PolicyDiagnosticsQuerySchema=z.strictObject({userId:IdSchema});
export const PolicyDiagnosticsSchema=z.strictObject({userId:IdSchema,policyVersion:version,rewardVersion:version,modelVersion:version,latestDecision:PolicyDecisionSchema.nullable(),counts:z.record(z.string(),count),labelDistribution:z.record(z.string(),count),rewardSummary:z.record(z.string(),z.number().nullable()),caveats:z.array(z.string())});
export type PolicyDiagnostics=z.infer<typeof PolicyDiagnosticsSchema>;
