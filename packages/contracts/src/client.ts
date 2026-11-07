import { z } from "zod";
import { CalibrationLabelRequestSchema, CalibrationQueueQuerySchema, ErrorEnvelopeSchema, IdempotencyKeySchema, PUBLIC_ROUTES, QueueQuerySchema, ReviewRequestSchema, UndoRequestSchema, UuidSchema, type CalibrationLabelRequest, type ErrorEnvelope, type ReviewRequest, type UndoRequest } from "./index";

export class ApiError extends Error {
  constructor(public status: number, public error: ErrorEnvelope) { super(error.message); this.name = "ApiError"; }
}
export function createApiClient(options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const response = await transport(`${base}${path}`, {method: body === undefined ? "GET" : "POST", credentials: "include", headers: body === undefined ? {Accept: "application/json"} : {Accept: "application/json", "Content-Type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorEnvelopeSchema.safeParse(payload);
      throw new ApiError(response.status, error.success ? error.data : {code: "INVALID_ERROR_RESPONSE", message: "The API returned an unreadable error.", retryable: response.status >= 500});
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ApiError(502, {code: "INVALID_API_RESPONSE", message: "The API response does not match the shared contract.", retryable: false});
    return parsed.data;
  }
  return {
    health: () => request(PUBLIC_ROUTES.health.path, PUBLIC_ROUTES.health.response),
    session: () => request(PUBLIC_ROUTES.me.path, PUBLIC_ROUTES.me.response),
    demoBootstrap: () => request(PUBLIC_ROUTES.demoBootstrap.path, PUBLIC_ROUTES.demoBootstrap.response),
    queue: (query: z.input<typeof QueueQuerySchema> = {}) => { const parsed = QueueQuerySchema.parse(query); return request(`${PUBLIC_ROUTES.queue.path}?${new URLSearchParams({limit: String(parsed.limit), policy: parsed.policy, mode: parsed.mode})}`, PUBLIC_ROUTES.queue.response); },
    decide: (body: ReviewRequest) => request(PUBLIC_ROUTES.decide.path, PUBLIC_ROUTES.decide.response, ReviewRequestSchema.parse(body)),
    undo: (decisionId: string, body: UndoRequest) => request(PUBLIC_ROUTES.undo.path.replace(":id", UuidSchema.parse(decisionId)), PUBLIC_ROUTES.undo.response, UndoRequestSchema.parse(body)),
    history: () => request(PUBLIC_ROUTES.history.path, PUBLIC_ROUTES.history.response),
    calibrationQueue: (query: z.input<typeof CalibrationQueueQuerySchema> = {}) => { const parsed = CalibrationQueueQuerySchema.parse(query); return request(`${PUBLIC_ROUTES.calibrationQueue.path}?${new URLSearchParams({limit: String(parsed.limit)})}`, PUBLIC_ROUTES.calibrationQueue.response); },
    calibrationLabel: (body: CalibrationLabelRequest) => request(PUBLIC_ROUTES.calibrationLabel.path, PUBLIC_ROUTES.calibrationLabel.response, CalibrationLabelRequestSchema.parse(body)),
    calibrationUndo: (labelId: string, body: UndoRequest) => request(PUBLIC_ROUTES.calibrationUndo.path.replace(":id", UuidSchema.parse(labelId)), PUBLIC_ROUTES.calibrationUndo.response, UndoRequestSchema.parse(body)),
    calibrationHistory: () => request(PUBLIC_ROUTES.calibrationHistory.path, PUBLIC_ROUTES.calibrationHistory.response),
    insights: () => request(PUBLIC_ROUTES.insights.path, PUBLIC_ROUTES.insights.response),
  };
}
export function createIdempotencyKey() { return IdempotencyKeySchema.parse(crypto.randomUUID()); }
