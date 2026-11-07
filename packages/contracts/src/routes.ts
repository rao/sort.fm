import { z } from "zod";
import { AccountSessionSchema, DecisionHistorySchema, DemoBootstrapSchema, HealthSchema, LibraryImportStatusSchema, LibrarySummarySchema, ModelInsightsSchema, ModelMetricsSchema, OkSchema, PlayRequestSchema, PlayerStatusSchema, QueueQuerySchema, QueueResultSchema, ReviewRequestSchema, ReviewResultSchema, UndoRequestSchema } from "./schemas";
import { EvaluationQuerySchema, ExplainQuerySchema, ExplainResponseSchema, FitRequestSchema, FitResponseSchema, ObserveRequestSchema, ObserveResponseSchema, ScoreRequestSchema, ScoreResponseSchema } from "./features";
import {CalibrationHistorySchema, CalibrationLabelRequestSchema, CalibrationLabelResultSchema, CalibrationQueueQuerySchema, CalibrationQueueResultSchema} from "./calibration";

// Request/response definitions are canonical; unimplemented endpoints return ErrorEnvelope.
export const PUBLIC_ROUTES = {
  health: {method: "GET", path: "/api/health", response: HealthSchema, auth: "public"},
  authStart: {method: "GET", path: "/api/auth/spotify/start", auth: "public"},
  authCallback: {method: "GET", path: "/api/auth/spotify/callback", auth: "public"},
  logout: {method: "POST", path: "/api/auth/logout", response: OkSchema, auth: "session"},
  me: {method: "GET", path: "/api/me", response: AccountSessionSchema, auth: "public"},
  sync: {method: "POST", path: "/api/library/sync", response: LibraryImportStatusSchema, auth: "owner"},
  syncStatus: {method: "GET", path: "/api/library/sync/status", response: LibraryImportStatusSchema, auth: "owner"},
  librarySummary: {method: "GET", path: "/api/library/summary", response: LibrarySummarySchema, auth: "owner"},
  queue: {method: "GET", path: "/api/queue", query: QueueQuerySchema, response: QueueResultSchema, auth: "session_or_explicit_demo"},
  decide: {method: "POST", path: "/api/decisions", body: ReviewRequestSchema, response: ReviewResultSchema, auth: "owner_or_demo"},
  undo: {method: "POST", path: "/api/decisions/:id/undo", body: UndoRequestSchema, response: ReviewResultSchema, auth: "owner_or_demo"},
  history: {method: "GET", path: "/api/decisions/history", response: DecisionHistorySchema, auth: "session"},
  calibrationQueue: {method: "GET", path: "/api/calibration/queue", query: CalibrationQueueQuerySchema, response: CalibrationQueueResultSchema, auth: "owner"},
  calibrationLabel: {method: "POST", path: "/api/calibration/labels", body: CalibrationLabelRequestSchema, response: CalibrationLabelResultSchema, auth: "owner"},
  calibrationUndo: {method: "POST", path: "/api/calibration/labels/:id/undo", body: UndoRequestSchema, response: CalibrationLabelResultSchema, auth: "owner"},
  calibrationHistory: {method: "GET", path: "/api/calibration/history", response: CalibrationHistorySchema, auth: "owner"},
  analytics: {method: "GET", path: "/api/analytics/summary", response: z.strictObject({library: LibrarySummarySchema, metrics: ModelMetricsSchema}), auth: "session"},
  insights: {method: "GET", path: "/api/ml/insights", response: ModelInsightsSchema, auth: "session"},
  retrain: {method: "POST", path: "/api/ml/retrain", response: FitResponseSchema, auth: "owner"},
  playerStatus: {method: "GET", path: "/api/player/status", response: PlayerStatusSchema, auth: "owner"},
  play: {method: "POST", path: "/api/player/play", body: PlayRequestSchema, response: OkSchema, auth: "owner"},
  demoBootstrap: {method: "GET", path: "/api/demo/bootstrap", response: DemoBootstrapSchema, auth: "public"},
} as const;
export const INTERNAL_ROUTES = {
  health: {method: "GET", path: "/health", auth: "public", response: z.strictObject({status: z.literal("ok"), service: z.literal("ml"), contractVersion: z.literal("1.0.0"), capabilities: z.strictObject({scoring: z.boolean(), training: z.boolean()})})},
  fit: {method: "POST", path: "/fit", body: FitRequestSchema, response: FitResponseSchema, auth: "shared_secret"},
  score: {method: "POST", path: "/score", body: ScoreRequestSchema, response: ScoreResponseSchema, auth: "shared_secret"},
  observe: {method: "POST", path: "/observe", body: ObserveRequestSchema, response: ObserveResponseSchema, auth: "shared_secret"},
  evaluation: {method: "GET", path: "/evaluation", query: EvaluationQuerySchema, response: ModelMetricsSchema, auth: "shared_secret"},
  explain: {method: "GET", path: "/explain", query: ExplainQuerySchema, response: ExplainResponseSchema, auth: "shared_secret"},
} as const;
