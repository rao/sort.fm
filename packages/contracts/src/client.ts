import {CalibrationBatchCreateSchema,CalibrationBatchSkipSchema,type CalibrationBatchSkip} from './calibration-batch';
import {CALIBRATION_BATCH3_EXPERIMENT,CalibrationExperimentIdSchema,CalibrationExperimentSkipSchema,type CalibrationExperimentSkip} from './calibration-experiment';
import { z } from "zod";
import { CalibrationLabelRequestSchema, CalibrationQueueQuerySchema, ErrorEnvelopeSchema, IdempotencyKeySchema, PUBLIC_ROUTES, QueueQuerySchema, ReviewRequestSchema, UndoRequestSchema, UuidSchema, type CalibrationLabelRequest, type ErrorEnvelope, type ReviewRequest, type UndoRequest } from "./index";
import {IdSchema} from './schemas';
import {PlaybackConnectRequestSchema,PlaybackPlayRequestSchema,PlaybackTransferRequestSchema,type PlaybackConnectRequest,type PlaybackPlayRequest,type PlaybackTransferRequest} from './playback';

export class ApiError extends Error {
  constructor(public status: number, public error: ErrorEnvelope) { super(error.message); this.name = "ApiError"; }
}
// Token failures may contain credentials even inside a valid upstream envelope.
// Only fixed local text/codes survive; never retain a cause or provider payload.
const tokenErrors:Record<string,{message:string;retryable:boolean}>={
 AUTHENTICATION_REQUIRED:{message:'Connect an authorized account before playback.',retryable:false},
 ACCOUNT_NOT_ALLOWED:{message:'This account is not authorized for playback.',retryable:false},
 SESSION_CHANGED:{message:'Your account changed. Reconnect playback.',retryable:false},
 CSRF_REJECTED:{message:'Playback must be requested from sort.fm.',retryable:false},
 ORIGIN_NOT_ALLOWED:{message:'Playback must be requested from sort.fm.',retryable:false},
 VALIDATION_ERROR:{message:'The playback request is invalid.',retryable:false},
 INVALID_API_RESPONSE:{message:'The playback credential response could not be verified.',retryable:false},
 PLAYBACK_PREMIUM_REQUIRED:{message:'Spotify Premium is required for browser playback.',retryable:false},
 PLAYBACK_RECONNECT_REQUIRED:{message:'Reconnect Spotify playback to continue.',retryable:false},
 PLAYBACK_SCOPE_REJECTED:{message:'The playback authorization has unexpected permissions. Reconnect playback.',retryable:false},
 PLAYBACK_RATE_LIMITED:{message:'Spotify temporarily limited playback requests. Try again later.',retryable:true},
 PLAYBACK_UNAVAILABLE:{message:'Browser playback is unavailable. Open this song in Spotify.',retryable:true},
};
export function createApiClient(options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const transport = options.fetch ?? globalThis.fetch;
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, safety:Pick<RequestInit,'cache'|'redirect'|'referrerPolicy'>={}): Promise<T> {
    const response = await transport(`${base}${path}`, {...safety,method: body === undefined ? "GET" : "POST", credentials: "include", headers: body === undefined ? {Accept: "application/json"} : {Accept: "application/json", "Content-Type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorEnvelopeSchema.safeParse(payload);
      throw new ApiError(response.status, error.success ? error.data : {code: "INVALID_ERROR_RESPONSE", message: "The API returned an unreadable error.", retryable: response.status >= 500});
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ApiError(502, {code: "INVALID_API_RESPONSE", message: "The API response does not match the shared contract.", retryable: false});
    return parsed.data;
  }
  async function playbackToken(expectedOwnerId:string) {
    try {
      IdSchema.parse(expectedOwnerId);
      const result=await request(PUBLIC_ROUTES.playbackToken.path,PUBLIC_ROUTES.playbackToken.response,{},
        {cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
      if(result.ownerId!==expectedOwnerId)throw new ApiError(401,{code:'SESSION_CHANGED',message:'Owner changed'});
      if(Date.parse(result.expiresAt)<=Date.now())throw new ApiError(401,{code:'PLAYBACK_RECONNECT_REQUIRED',message:'Credential expired'});
      return result;
    } catch(error) {
      const code=error instanceof ApiError&&Object.hasOwn(tokenErrors,error.error.code)?error.error.code:'PLAYBACK_UNAVAILABLE';
      const safe=tokenErrors[code]!;
      throw new ApiError(error instanceof ApiError?error.status:503,{code,...safe});
    }
  }
  return {
    health: () => request(PUBLIC_ROUTES.health.path, PUBLIC_ROUTES.health.response),
    session: () => request(PUBLIC_ROUTES.me.path, PUBLIC_ROUTES.me.response),
    demoBootstrap: () => request(PUBLIC_ROUTES.demoBootstrap.path, PUBLIC_ROUTES.demoBootstrap.response),
    queue: (query: z.input<typeof QueueQuerySchema> = {}) => { const parsed = QueueQuerySchema.parse(query); return request(`${PUBLIC_ROUTES.queue.path}?${new URLSearchParams({limit: String(parsed.limit), policy: parsed.policy, mode: parsed.mode})}`, PUBLIC_ROUTES.queue.response); },
    decide: (body: ReviewRequest) => request(PUBLIC_ROUTES.decide.path, PUBLIC_ROUTES.decide.response, ReviewRequestSchema.parse(body)),
    undo: (decisionId: string, body: UndoRequest) => request(PUBLIC_ROUTES.undo.path.replace(":id", UuidSchema.parse(decisionId)), PUBLIC_ROUTES.undo.response, UndoRequestSchema.parse(body)),
    history: () => request(PUBLIC_ROUTES.history.path, PUBLIC_ROUTES.history.response),
    calibrationBatch: () => request(PUBLIC_ROUTES.calibrationBatch.path,PUBLIC_ROUTES.calibrationBatch.response,undefined,{cache:'no-store'}),
    calibrationBatchCreate: (body:z.input<typeof CalibrationBatchCreateSchema>={}) => request(PUBLIC_ROUTES.calibrationBatchCreate.path,PUBLIC_ROUTES.calibrationBatchCreate.response,CalibrationBatchCreateSchema.parse(body)),
    calibrationBatchSkip: (body:CalibrationBatchSkip) => request(PUBLIC_ROUTES.calibrationBatchSkip.path,PUBLIC_ROUTES.calibrationBatchSkip.response,CalibrationBatchSkipSchema.parse(body)),
    calibrationExperiment: (experiment=CALIBRATION_BATCH3_EXPERIMENT) => request(PUBLIC_ROUTES.calibrationExperiment.path.replace(':experiment',CalibrationExperimentIdSchema.parse(experiment)),PUBLIC_ROUTES.calibrationExperiment.response,undefined,{cache:'no-store'}),
    calibrationExperimentSkip: (body:CalibrationExperimentSkip,experiment=CALIBRATION_BATCH3_EXPERIMENT) => request(PUBLIC_ROUTES.calibrationExperimentSkip.path.replace(':experiment',CalibrationExperimentIdSchema.parse(experiment)),PUBLIC_ROUTES.calibrationExperimentSkip.response,CalibrationExperimentSkipSchema.parse(body),{cache:'no-store'}),
    calibrationQueue: (query: z.input<typeof CalibrationQueueQuerySchema> = {}) => { const parsed = CalibrationQueueQuerySchema.parse(query); return request(`${PUBLIC_ROUTES.calibrationQueue.path}?${new URLSearchParams({limit: String(parsed.limit)})}`, PUBLIC_ROUTES.calibrationQueue.response); },
    calibrationLabel: (body: CalibrationLabelRequest) => request(PUBLIC_ROUTES.calibrationLabel.path, PUBLIC_ROUTES.calibrationLabel.response, CalibrationLabelRequestSchema.parse(body)),
    calibrationUndo: (labelId: string, body: UndoRequest) => request(PUBLIC_ROUTES.calibrationUndo.path.replace(":id", UuidSchema.parse(labelId)), PUBLIC_ROUTES.calibrationUndo.response, UndoRequestSchema.parse(body)),
    calibrationHistory: () => request(PUBLIC_ROUTES.calibrationHistory.path, PUBLIC_ROUTES.calibrationHistory.response),
    insights: () => request(PUBLIC_ROUTES.insights.path, PUBLIC_ROUTES.insights.response),
    playerStatus: () => request(PUBLIC_ROUTES.playerStatus.path,PUBLIC_ROUTES.playerStatus.response),
    playbackConnection: () => request(PUBLIC_ROUTES.playbackConnection.path,PUBLIC_ROUTES.playbackConnection.response),
    connectPlayback: (body:PlaybackConnectRequest) => request(PUBLIC_ROUTES.playbackConnect.path,PUBLIC_ROUTES.playbackConnect.response,PlaybackConnectRequestSchema.parse(body)),
    playbackToken,
    playOnDevice: (body:PlaybackPlayRequest) => request(PUBLIC_ROUTES.playbackPlay.path,PUBLIC_ROUTES.playbackPlay.response,PlaybackPlayRequestSchema.parse(body)),
    transferPlayback: (body:PlaybackTransferRequest) => request(PUBLIC_ROUTES.playbackTransfer.path,PUBLIC_ROUTES.playbackTransfer.response,PlaybackTransferRequestSchema.parse(body)),
  };
}
export function createIdempotencyKey() { return IdempotencyKeySchema.parse(crypto.randomUUID()); }
