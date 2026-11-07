import { z } from "zod";
import { CountSchema, FEATURE_VERSION, IdSchema, ModelMetricsSchema, PredictionSchema, ProbabilitySchema, TimestampSchema, UuidSchema } from "./schemas";

// Missing is null/omitted, never zero. No undocumented Spotify audio/popularity fields.
export const FeatureValuesSchema = z.strictObject({
  saved_age_days: z.number().nonnegative().nullable().optional(),
  release_age_years: z.number().nonnegative().nullable().optional(),
  duration_ms: CountSchema.nullable().optional(), artist_library_count: CountSchema.nullable().optional(),
  top_track_short: ProbabilitySchema.nullable().optional(), top_track_medium: ProbabilitySchema.nullable().optional(),
  top_track_long: ProbabilitySchema.nullable().optional(), top_artist: ProbabilitySchema.nullable().optional(),
  recent_play_count: CountSchema.nullable().optional(),
  energy: ProbabilitySchema.nullable().optional(), danceability: ProbabilitySchema.nullable().optional(),
  happiness: ProbabilitySchema.nullable().optional(), acousticness: ProbabilitySchema.nullable().optional(),
  instrumentalness: ProbabilitySchema.nullable().optional(), liveness: ProbabilitySchema.nullable().optional(),
  speechiness: ProbabilitySchema.nullable().optional(), tempo_bpm: z.number().positive().max(400).nullable().optional(),
  loudness_db: z.number().min(-100).max(10).nullable().optional(),
  key_sin: z.number().min(-1).max(1).nullable().optional(), key_cos: z.number().min(-1).max(1).nullable().optional(),
  mode_major: z.union([z.literal(0), z.literal(1)]).nullable().optional(),
  soundnet_popularity: ProbabilitySchema.nullable().optional(),
  kept_centroid_distance: z.number().nonnegative().nullable().optional(),
  removed_centroid_distance: z.number().nonnegative().nullable().optional(),
});
export const FEATURE_KEYS = Object.keys(FeatureValuesSchema.shape) as (keyof z.infer<typeof FeatureValuesSchema>)[];
export const FeatureVectorSchema = z.strictObject({featureVersion: z.literal(FEATURE_VERSION), values: FeatureValuesSchema, provenance: z.enum(["synthetic", "licensed", "spotify", "soundnet"]), permittedForTraining: z.boolean(), rightsBasis: z.string().min(1).optional()});
export type FeatureVector = z.infer<typeof FeatureVectorSchema>;
export const CandidateSchema = z.strictObject({trackId: IdSchema, features: FeatureVectorSchema});
export const TrainingExampleSchema = CandidateSchema.extend({decisionId: UuidSchema, label: z.union([z.literal(0), z.literal(1)]), split: z.enum(["train", "holdout"]), labeledAt: TimestampSchema});
export const FitRequestSchema = z.strictObject({userId: IdSchema, featureVersion: z.literal(FEATURE_VERSION), feedbackRevision: CountSchema, examples: z.array(TrainingExampleSchema), evaluationSeed: z.number().int()});
export const FitResponseSchema = z.strictObject({userId: IdSchema, modelVersion: z.string(), featureVersion: z.literal(FEATURE_VERSION), feedbackRevision: CountSchema, trainedExamples: CountSchema, metrics: ModelMetricsSchema});
export const ScoreRequestSchema = z.strictObject({userId: IdSchema, featureVersion: z.literal(FEATURE_VERSION), candidates: z.array(CandidateSchema).max(10000), modelVersion: z.string().nullable()});
export const ScoreResponseSchema = z.strictObject({userId: IdSchema, modelVersion: z.string(), featureVersion: z.literal(FEATURE_VERSION), predictions: z.array(z.strictObject({trackId: IdSchema, prediction: PredictionSchema}))});
export const ObserveRequestSchema = z.strictObject({userId: IdSchema, eventId: UuidSchema, decisionId: UuidSchema, exposureId: UuidSchema, trackId: IdSchema, feedbackRevision: CountSchema, operation: z.enum(["upsert", "revoke"]), label: z.union([z.literal(0), z.literal(1)]).nullable(), features: FeatureVectorSchema, occurredAt: TimestampSchema}).superRefine((event, ctx) => {
  if (event.operation === "revoke" && event.label !== null) ctx.addIssue({code: "custom", message: "Revocation removes the prior label"});
});
export const ObserveResponseSchema = z.strictObject({accepted: z.boolean(), feedbackRevision: CountSchema, modelVersion: z.string().nullable()});
export const EvaluationQuerySchema = z.strictObject({userId: IdSchema, modelVersion: z.string().optional()});
export const ExplainQuerySchema = z.strictObject({userId: IdSchema, exposureId: UuidSchema});
export const ExplainResponseSchema = z.strictObject({exposureId: UuidSchema, prediction: PredictionSchema});
export type FitRequest = z.infer<typeof FitRequestSchema>;
export type ScoreRequest = z.infer<typeof ScoreRequestSchema>;
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;
export type FitResponse = z.infer<typeof FitResponseSchema>;
export type ScoreResponse = z.infer<typeof ScoreResponseSchema>;
export type ObserveResponse = z.infer<typeof ObserveResponseSchema>;
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;
