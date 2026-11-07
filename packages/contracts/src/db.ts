import { z } from "zod";
import { FeatureVectorSchema } from "./features";
import { CountSchema, ExposureSchema, FEATURE_VERSION, IdSchema, LibraryImportStatusSchema, ModelMetricsSchema, MutationStatusSchema, MutationStepSchema, PredictionSchema, ReviewRequestSchema, TimestampSchema, TrackCardSchema, UndoRequestSchema, UuidSchema, predictionMatchesExposure } from "./schemas";

// Internal DB inputs ONLY. userId is resolved by the server, never trusted from a browser.
export const TrackInputSchema = z.strictObject({track: TrackCardSchema, fetchedAt: TimestampSchema});
export const SavedTrackInputSchema = z.strictObject({userId: IdSchema, track: TrackCardSchema, originalAddedAt: TimestampSchema, syncedAt: TimestampSchema, currentStatus: z.enum(["saved", "kept", "deferred", "archived", "unliked"])});
export const ExposureInputSchema = z.strictObject({userId: IdSchema, exposure: ExposureSchema, prediction: PredictionSchema, features: FeatureVectorSchema}).refine(input => predictionMatchesExposure(input.prediction, input.exposure) && input.features.featureVersion === input.exposure.featureVersion, "Exposure must preserve the full prediction and feature snapshot");
export const DecisionInputSchema = z.strictObject({userId: IdSchema, decisionId: UuidSchema, request: ReviewRequestSchema, requestFingerprint: z.string().min(1), createdAt: TimestampSchema});
export const UndoCommandInputSchema = z.strictObject({userId: IdSchema, commandId: UuidSchema, decisionId: UuidSchema, request: UndoRequestSchema, requestFingerprint: z.string().min(1), createdAt: TimestampSchema});
export const MutationTransitionInputSchema = z.strictObject({userId: IdSchema, mutationId: UuidSchema, decisionId: UuidSchema, expectedStatus: MutationStatusSchema, status: MutationStatusSchema, step: MutationStepSchema, attempts: CountSchema, archivePlaylistId: IdSchema.nullable(), occurredAt: TimestampSchema});
export const FeedbackRevisionInputSchema = z.strictObject({userId: IdSchema, decisionId: UuidSchema, revision: CountSchema, label: z.union([z.literal(0), z.literal(1)]).nullable(), revoked: z.boolean(), occurredAt: TimestampSchema});
export const AudioFeaturesInputSchema = z.strictObject({trackId: IdSchema, provider: z.enum(["soundnet", "musicae"]), raw: z.unknown(), normalized: FeatureVectorSchema, fetchedAt: TimestampSchema, status: z.enum(["pending", "running", "success", "failed"]), dataQuality: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))});
export const ModelRunInputSchema = z.strictObject({runId: UuidSchema, userId: IdSchema, modelVersion: z.string().min(1), modelKind: z.string().min(1), featureVersion: z.literal(FEATURE_VERSION), artifactPath: z.string(), trainedExamples: CountSchema, feedbackRevision: CountSchema, metrics: ModelMetricsSchema, createdAt: TimestampSchema});
export const ImportProgressInputSchema = z.strictObject({userId: IdSchema, progress: LibraryImportStatusSchema});
export const TelemetryInputSchema = z.strictObject({eventId: UuidSchema, userId: IdSchema, modelVersion: z.string().nullable(), eventType: z.enum(["exposure", "decision", "undo", "training", "provider_fetch"]), predictionScore: z.number().min(0).max(1).nullable(), uncertainty: z.number().min(0).max(1).nullable(), processingLatencyMs: z.number().nonnegative(), occurredAt: TimestampSchema});
export type SavedTrackInput = z.infer<typeof SavedTrackInputSchema>;
export type TrackInput = z.infer<typeof TrackInputSchema>;
export type UndoCommandInput = z.infer<typeof UndoCommandInputSchema>;
export type MutationTransitionInput = z.infer<typeof MutationTransitionInputSchema>;
export type FeedbackRevisionInput = z.infer<typeof FeedbackRevisionInputSchema>;
export type ImportProgressInput = z.infer<typeof ImportProgressInputSchema>;
export type ExposureInput = z.infer<typeof ExposureInputSchema>;
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type AudioFeaturesInput = z.infer<typeof AudioFeaturesInputSchema>;
export type ModelRunInput = z.infer<typeof ModelRunInputSchema>;
export type TelemetryInput = z.infer<typeof TelemetryInputSchema>;
