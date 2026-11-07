import {z} from "zod";
import {CONTRACT_VERSION, CountSchema, IdempotencyKeySchema, QueueItemSchema, SpotifyTrackIdSchema, TimestampSchema, UuidSchema} from "./schemas";

/** A human preference label, never an instruction to change Spotify. */
export const CalibrationLabelRequestSchema = z.strictObject({
  trackId: SpotifyTrackIdSchema, exposureId: UuidSchema,
  label: z.union([z.literal(0), z.literal(1)]), idempotencyKey: IdempotencyKeySchema,
});
export type CalibrationLabelRequest = z.infer<typeof CalibrationLabelRequestSchema>;

export const CalibrationLabelResultSchema = z.strictObject({
  mode: z.literal("calibration"), labelId: UuidSchema, trackId: SpotifyTrackIdSchema,
  exposureId: UuidSchema, idempotencyKey: IdempotencyKeySchema,
  submittedLabel: z.union([z.literal(0), z.literal(1)]),
  label: z.union([z.literal(0), z.literal(1)]).nullable(),
  state: z.enum(["active", "revoked", "superseded"]), canUndo: z.boolean(),
  feedbackRevision: CountSchema.min(1),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).superRefine((result, ctx) => {
  if (result.state === "active" ? result.label !== result.submittedLabel : result.label !== null || result.canUndo) {
    ctx.addIssue({code: "custom", message: "Only the current active calibration label contributes to training or permits Undo"});
  }
  if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) {
    ctx.addIssue({code: "custom", message: "A label cannot be updated before it is created"});
  }
});
export type CalibrationLabelResult = z.infer<typeof CalibrationLabelResultSchema>;

// No client-selected policy, split, purpose or owner. Sampling is server-owned.
export const CalibrationQueueQuerySchema = z.strictObject({limit: z.coerce.number().int().min(1).max(100).default(20)});
export type CalibrationQueueQuery = z.infer<typeof CalibrationQueueQuerySchema>;
export const CalibrationQueueResultSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION), mode: z.literal("calibration"),
  items: z.array(QueueItemSchema).max(100), remaining: CountSchema,
  nextCursor: z.string().nullable(), fallbackReason: z.string().nullable(),
}).superRefine((queue, ctx) => {
  if (queue.items.some(item => item.track.source !== "spotify")) {
    ctx.addIssue({code: "custom", message: "Calibration labels require the owner's real imported tracks"});
  }
  if (queue.remaining < queue.items.length
    || new Set(queue.items.map(item => item.track.trackId)).size !== queue.items.length
    || new Set(queue.items.map(item => item.exposure.exposureId)).size !== queue.items.length) {
    ctx.addIssue({code: "custom", message: "Calibration cards must have unique identities within the remaining candidate pool"});
  }
});
export type CalibrationQueueResult = z.infer<typeof CalibrationQueueResultSchema>;
export const CalibrationHistorySchema = z.strictObject({items: z.array(CalibrationLabelResultSchema), nextCursor: z.string().nullable()});
export type CalibrationHistory = z.infer<typeof CalibrationHistorySchema>;
