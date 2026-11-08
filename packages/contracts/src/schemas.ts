import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0" as const;
export const FEATURE_VERSION = "sortfm.features.v1" as const;
export const IdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9:_.-]+$/);
export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime({offset: true});
export const ProbabilitySchema = z.number().min(0).max(1);
export const CountSchema = z.number().int().nonnegative();
export const SpotifyTrackIdSchema = z.string().regex(/^[a-zA-Z0-9]{22}$/);
export const SpotifyTrackUriSchema = z.string().regex(/^spotify:track:[a-zA-Z0-9]{22}$/);
export const HttpUrlSchema = z.url({protocol: /^https?$/});
export const ErrorEnvelopeSchema = z.strictObject({code: z.string().min(1), message: z.string().min(1), retryable: z.boolean().optional()});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
export const ReviewActionSchema = z.enum(["KEEP", "ARCHIVE", "SKIP", "UNLIKE"]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;
export const ACTION_SEMANTICS = {
  KEEP: {key: "ArrowRight", label: 0, spotifyWrite: false},
  ARCHIVE: {key: "ArrowLeft", label: 1, spotifyWrite: true},
  SKIP: {key: "ArrowUp", label: null, spotifyWrite: false},
  UNLIKE: {key: "ArrowDown", label: 1, spotifyWrite: true},
} as const;
export function labelForAction(action: ReviewAction): 0 | 1 | null { return ACTION_SEMANTICS[action].label; }
export const IdempotencyKeySchema = UuidSchema.brand<"IdempotencyKey">();
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export const ReviewRequestSchema = z.strictObject({trackId: IdSchema, action: ReviewActionSchema, exposureId: UuidSchema, idempotencyKey: IdempotencyKeySchema});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;
export const UndoRequestSchema = z.strictObject({idempotencyKey: IdempotencyKeySchema});
export type UndoRequest = z.infer<typeof UndoRequestSchema>;

export const TrackCardSchema = z.strictObject({
  trackId: IdSchema, source: z.enum(["spotify", "synthetic"]), spotifyUri: SpotifyTrackUriSchema.nullable(),
  title: z.string().min(1), artists: z.array(z.strictObject({id: IdSchema.nullable(), name: z.string().min(1)})).min(1),
  album: z.string(), imageUrl: HttpUrlSchema.nullable(), durationMs: CountSchema, explicit: z.boolean(),
  originalAddedAt: TimestampSchema, releaseDate: z.string().regex(/^\d{4}(-\d{2})?(-\d{2})?$/).nullable(), isPlayable: z.boolean(),
}).superRefine((track, ctx) => {
  if (track.source === "synthetic" && (track.spotifyUri !== null || !track.trackId.startsWith("demo:"))) ctx.addIssue({code: "custom", message: "Synthetic tracks require demo: IDs and no Spotify URI"});
  if (track.source === "spotify" && (!SpotifyTrackIdSchema.safeParse(track.trackId).success || track.spotifyUri !== `spotify:track:${track.trackId}`)) ctx.addIssue({code: "custom", message: "Spotify track ID and URI must match"});
});
export type TrackCard = z.infer<typeof TrackCardSchema>;

export const MutationStatusSchema = z.enum(["PENDING", "COMPLETE", "FAILED_RETRYABLE", "FAILED_TERMINAL", "UNDONE"]);
export const MutationStepSchema = z.enum(["NONE", "PENDING", "ARCHIVED_PLAYLIST_INSERTED", "UNLIKED", "RESTORED", "RECONCILING"]);
export const ReviewResultSchema = z.strictObject({
  decisionId: UuidSchema, trackId: IdSchema, action: ReviewActionSchema, exposureId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema, status: MutationStatusSchema, mutationStep: MutationStepSchema,
  mode: z.enum(["demo", "spotify"]), liked: z.boolean().nullable(), archived: z.boolean().nullable(),
  canUndo: z.boolean(), label: z.union([z.literal(0), z.literal(1)]).nullable(),
  labelState: z.enum(["inactive", "active", "revoked"]), feedbackRevision: CountSchema,
  error: ErrorEnvelopeSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).superRefine((result, ctx) => {
  const destructive = result.action === "ARCHIVE" || result.action === "UNLIKE";
  if (result.canUndo && result.status !== "COMPLETE") ctx.addIssue({code: "custom", message: "Only settled complete decisions may advertise Undo"});
  if (result.labelState === "active" && (result.status !== "COMPLETE" || result.label === null || result.label !== labelForAction(result.action))) ctx.addIssue({code: "custom", message: "Only a completed decision may activate its correct label"});
  if (result.status === "COMPLETE" && result.action !== "SKIP" && result.labelState !== "active") ctx.addIssue({code: "custom", message: "Completed strong decisions activate their label"});
  if (result.status === "COMPLETE" && (result.mutationStep !== (destructive ? "UNLIKED" : "NONE") || result.error !== null)) ctx.addIssue({code: "custom", message: "Complete decisions must have a settled step and no outstanding error"});
  if (result.labelState !== "active" && result.label !== null) ctx.addIssue({code: "custom", message: "Inactive/revoked labels must be null"});
  if (result.status === "UNDONE" && (result.labelState !== "revoked" || result.canUndo)) ctx.addIssue({code: "custom", message: "Undone decisions revoke labels and cannot be undone again"});
  if (result.status === "UNDONE" && (result.mutationStep !== (destructive ? "RESTORED" : "NONE") || (destructive && result.liked !== true))) ctx.addIssue({code: "custom", message: "Undo requires confirmed restoration of destructive decisions"});
  if (result.status === "COMPLETE" && ["ARCHIVE", "UNLIKE"].includes(result.action) && (result.liked !== false || (result.action === "ARCHIVE" && result.archived !== true))) ctx.addIssue({code: "custom", message: "Completed destructive operations require confirmed remote state"});
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export const PredictionSchema = z.strictObject({
  modelKind: z.enum(["untrained", "heuristic", "logistic", "sgd_logistic", "tree"]),
  modelVersion: z.string().min(1), featureVersion: z.literal(FEATURE_VERSION), trainedExamples: CountSchema,
  removalProbability: ProbabilitySchema.nullable(), heuristicScore: ProbabilitySchema.nullable(),
  uncertainty: ProbabilitySchema.nullable(), uncertaintyMethod: z.enum(["none", "entropy", "bootstrap"]).nullable(),
  calibrated: z.boolean(), explanations: z.array(z.strictObject({feature: z.string(), value: z.number().nullable(), contribution: z.number().nullable(), description: z.string()})),
}).superRefine((p, ctx) => {
  if (["untrained", "heuristic"].includes(p.modelKind) && (p.removalProbability !== null || p.calibrated)) ctx.addIssue({code: "custom", message: "Baseline heuristics are not trained probabilities"});
});
export type Prediction = z.infer<typeof PredictionSchema>;
export const QueuePolicySchema = z.enum(["balanced", "discovery", "certainty"]);
export type QueuePolicy = z.infer<typeof QueuePolicySchema>;
/** Reported lifecycle snapshot, not proof of viewing or current database eligibility. */
export const PolicyReservationSnapshotSchema = z.strictObject({
  reservedAt: TimestampSchema, expiresAt: TimestampSchema, evaluatedAt: TimestampSchema,
  status: z.enum(["active", "released", "expired"]), closedAt: TimestampSchema.nullable(),
  closureReason: z.enum(["explicit_release", "undo", "skip", "expiry"]).nullable(),
}).superRefine((r,ctx)=>{
  const start=Date.parse(r.reservedAt),end=Date.parse(r.expiresAt),at=Date.parse(r.evaluatedAt);
  const closed=r.closedAt===null?null:Date.parse(r.closedAt);
  const validDuration=end-start>=30_000&&end-start<=900_000;
  const coherent=r.status==='active'
    ? closed===null&&r.closureReason===null&&at<end
    : r.status==='expired'
      ? closed===end&&r.closureReason==='expiry'&&at>=end
      : closed!==null&&closed>=start&&closed<=end&&closed<=at&&['explicit_release','undo','skip'].includes(r.closureReason??'');
  if(!validDuration||at<start||!coherent)ctx.addIssue({code:'custom',message:'Policy reservation snapshot must preserve its bounded lifecycle'});
});
export type PolicyReservationSnapshot = z.infer<typeof PolicyReservationSnapshotSchema>;
/** C2 utility/design quantities are not classifier probabilities or calibrated confidence. */
export const PolicyTelemetrySchema = z.strictObject({
  selectionMethod:z.enum(['c1','epsilon_greedy','linucb','random']),strategy:z.enum(['explore','exploit']),
  policyStateVersion:z.string().min(1),contextVersion:z.string().min(1),rewardVersion:z.string().min(1),
  modelFeedbackRevision:CountSchema,predictedReward:z.number(),selectionScore:z.number(),
  uncertainty:z.number().nonnegative(),explorationBonus:z.number().nonnegative(),informationGain:z.number().nonnegative(),
  candidateCount:CountSchema,availableCount:CountSchema,eligibleCount:CountSchema,trainedRewards:CountSchema,
  reasons:z.array(z.string()),reservation:PolicyReservationSnapshotSchema,
}).superRefine((t,ctx)=>{
  if(t.eligibleCount>t.availableCount||t.availableCount>t.candidateCount)ctx.addIssue({code:'custom',message:'Policy counts must describe nested candidate populations'});
});
export type PolicyTelemetry = z.infer<typeof PolicyTelemetrySchema>;
export const ExposureSchema = z.strictObject({
  exposureId: UuidSchema, trackId: IdSchema, policy: QueuePolicySchema,
  selectionMethod: z.enum(["fixture", "deterministic_baseline", "logistic_rank", "linucb", "thompson", "epsilon_greedy"]),
  policyVersion: z.string().min(1), explorationCoefficient: z.number().nonnegative(),
  propensityEstimate: ProbabilitySchema.nullable(), modelVersion: z.string().min(1), featureVersion: z.literal(FEATURE_VERSION),
  removalScore: ProbabilitySchema.nullable(), heuristicScore: ProbabilitySchema.nullable(), uncertainty: ProbabilitySchema.nullable(),
  position: CountSchema, servedAt: TimestampSchema,
  policyTelemetry: PolicyTelemetrySchema.optional(),
});
export type Exposure = z.infer<typeof ExposureSchema>;
export function predictionMatchesExposure(prediction: Prediction, exposure: Exposure): boolean {
  return prediction.modelVersion === exposure.modelVersion && prediction.featureVersion === exposure.featureVersion
    && prediction.removalProbability === exposure.removalScore && prediction.heuristicScore === exposure.heuristicScore
    && prediction.uncertainty === exposure.uncertainty;
}
export const QueueItemSchema = z.strictObject({track: TrackCardSchema, prediction: PredictionSchema, exposure: ExposureSchema}).superRefine((item, ctx) => {
  if (item.track.trackId !== item.exposure.trackId || !predictionMatchesExposure(item.prediction, item.exposure)) ctx.addIssue({code: "custom", message: "Exposure must preserve track and prediction identity"});
});
export const QueueResultSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION), mode: z.enum(["demo", "spotify"]), items: z.array(QueueItemSchema),
  remaining: CountSchema, nextCursor: z.string().nullable(), fallbackReason: z.string().nullable(),
}).superRefine((queue, ctx) => {
  if (queue.items.some(item => item.track.source !== (queue.mode === "demo" ? "synthetic" : "spotify"))) ctx.addIssue({code: "custom", message: "Queue mode and data provenance must match"});
});
export type QueueResult = z.infer<typeof QueueResultSchema>;
export const QueueQuerySchema = z.strictObject({limit: z.coerce.number().int().min(1).max(100).default(20), policy: QueuePolicySchema.default("balanced"), mode: z.enum(["demo", "spotify"]).default("spotify")});

export const ModelMetricsSchema = z.strictObject({
  status: z.enum(["insufficient_data", "available", "unavailable"]), reason: z.string().nullable(),
  modelVersion: z.string().min(1), dataset: z.enum(["synthetic", "user_feedback", "licensed"]),
  evaluationMethod: z.enum(["none", "fixed_holdout", "cross_validation", "heldout_simulation"]),
  labeledExamples: CountSchema, trainedExamples: CountSchema, heldOutExamples: CountSchema,
  heldOutPositive: CountSchema, heldOutNegative: CountSchema, baseRate: ProbabilitySchema.nullable(),
  balancedAccuracy: ProbabilitySchema.nullable(), rocAuc: ProbabilitySchema.nullable(), prAuc: ProbabilitySchema.nullable(),
  logLoss: z.number().nonnegative().nullable(), brierScore: ProbabilitySchema.nullable(), precisionAtK: ProbabilitySchema.nullable(), evaluatedAt: TimestampSchema.nullable(),
}).superRefine((m, ctx) => {
  const metrics = [m.baseRate, m.balancedAccuracy, m.rocAuc, m.prAuc, m.logLoss, m.brierScore, m.precisionAtK];
  if (m.status !== "available" && metrics.some(value => value !== null)) ctx.addIssue({code: "custom", message: "Unavailable evaluation metrics must be null"});
  if (m.heldOutPositive + m.heldOutNegative !== m.heldOutExamples) ctx.addIssue({code: "custom", message: "Holdout class counts must sum to total"});
  if (m.trainedExamples > m.labeledExamples || m.heldOutExamples > m.labeledExamples || (m.evaluationMethod === "fixed_holdout" && m.trainedExamples + m.heldOutExamples > m.labeledExamples)) ctx.addIssue({code: "custom", message: "Training and holdout counts cannot exceed collected labels"});
  if (m.status === "available" && (metrics.slice(0, -1).some(value => value === null) || m.baseRate === null || Math.abs(m.baseRate - m.heldOutPositive / m.heldOutExamples) > 1e-6)) ctx.addIssue({code: "custom", message: "Available evaluation requires computed metrics and an accurate base rate"});
  if (m.status === "available" && (m.heldOutExamples < 20 || m.heldOutPositive === 0 || m.heldOutNegative === 0 || m.evaluationMethod === "none" || m.evaluatedAt === null)) ctx.addIssue({code: "custom", message: "Evaluation requires >=20 held-out examples, both classes, method and timestamp"});
});
export type ModelMetrics = z.infer<typeof ModelMetricsSchema>;

export const LibraryImportStatusSchema = z.strictObject({jobId: UuidSchema.nullable(), status: z.enum(["idle", "pending", "running", "complete", "failed"]), processed: CountSchema, total: CountSchema.nullable(), failed: CountSchema, nextOffset: CountSchema, updatedAt: TimestampSchema.nullable(), error: ErrorEnvelopeSchema.nullable()});
export type LibraryImportStatus = z.infer<typeof LibraryImportStatusSchema>;
export const ImportProgressSchema = LibraryImportStatusSchema;
export type ImportProgress = LibraryImportStatus;
export const AudioFeatureStatusSchema = z.strictObject({provider: z.enum(["soundnet", "musicae"]), status: z.enum(["disabled", "pending", "running", "complete", "failed"]), featuresReady: CountSchema, featuresTotal: CountSchema, failed: CountSchema, missingness: z.record(z.string(), ProbabilitySchema), reason: z.string().nullable()});
export type AudioFeatureStatus = z.infer<typeof AudioFeatureStatusSchema>;
const CapabilitiesSchema = z.strictObject({spotifyRead: z.boolean(), spotifyWrite: z.boolean(), playback: z.boolean()});
export const AccountSessionSchema = z.strictObject({mode: z.enum(["anonymous", "demo", "spotify"]), user: z.strictObject({id: IdSchema, spotifyId: IdSchema.nullable(), displayName: z.string(), avatarUrl: HttpUrlSchema.nullable()}).nullable(), capabilities: CapabilitiesSchema}).superRefine((s, ctx) => {
  if (s.mode !== "spotify" && (s.capabilities.spotifyRead || s.capabilities.spotifyWrite || s.capabilities.playback || s.user?.spotifyId)) ctx.addIssue({code: "custom", message: "Only Spotify sessions can have Spotify capabilities"});
  if ((s.mode === "anonymous") !== (s.user === null)) ctx.addIssue({code: "custom", message: "Only anonymous sessions omit the user"});
  if (s.mode === "spotify" && !s.user?.spotifyId) ctx.addIssue({code: "custom", message: "Spotify sessions require a Spotify identity"});
});
export type AccountSession = z.infer<typeof AccountSessionSchema>;
export const HealthSchema = z.strictObject({status: z.literal("ok"), service: z.literal("api"), contractVersion: z.literal(CONTRACT_VERSION), capabilities: z.strictObject({demo: z.boolean(), spotify: z.boolean(), database: z.boolean(), ml: z.boolean()})});
export const DemoBootstrapSchema = z.strictObject({session: AccountSessionSchema, queue: QueueResultSchema, metrics: ModelMetricsSchema, notice: z.string()});
export type DemoBootstrap = z.infer<typeof DemoBootstrapSchema>;
export const LibrarySummarySchema = z.strictObject({total: CountSchema, reviewed: CountSchema, remaining: CountSchema, archived: CountSchema, unliked: CountSchema, kept: CountSchema, skipped: CountSchema});
export const DecisionHistorySchema = z.strictObject({items: z.array(ReviewResultSchema), nextCursor: z.string().nullable()});
export const ModelInsightsSchema = z.strictObject({prediction: PredictionSchema.nullable(), metrics: ModelMetricsSchema, audioFeatures: AudioFeatureStatusSchema});
export const PlayerStatusSchema = z.strictObject({available: z.boolean(), deviceId: z.string().nullable(), isPlaying: z.boolean(), trackUri: SpotifyTrackUriSchema.nullable(), reason: z.string().nullable()});
export const PlayRequestSchema = z.strictObject({trackUri: SpotifyTrackUriSchema});
export const OkSchema = z.strictObject({ok: z.literal(true)});
