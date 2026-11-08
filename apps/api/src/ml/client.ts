// Server-only adapter. Import from the API package, never a browser/shared entry point.
// Configuration is injected by the API composition root; this module reads no env vars.
import {
  ErrorEnvelopeSchema, EvaluationQuerySchema, ExplainQuerySchema, INTERNAL_ROUTES,
  type ExplainResponse, type FitRequest, type FitResponse, type ModelMetrics,
  type ObserveRequest, type ObserveResponse, type ScoreRequest, type ScoreResponse,
  type PolicyAssociationRequest, type PolicyAssociationReceipt,
  type PolicySelectRequest, type PolicyDecision, type PolicyExposure, type PolicyReleaseRequest, type PolicyReleaseReceipt,
} from "@sortfm/contracts";
import type { z } from "zod";

export interface MlClient {
  fit(request: FitRequest): Promise<FitResponse>;
  score(request: ScoreRequest): Promise<ScoreResponse>;
  observe(request: ObserveRequest): Promise<ObserveResponse>;
  evaluation(query: { userId: string; modelVersion?: string }): Promise<ModelMetrics>;
  explain(query: { userId: string; exposureId: string }): Promise<ExplainResponse>;
}

// The callable fetch contract also admits test transports without Bun's optional preconnect helper.
export type MlFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

const UPSTREAM_ERROR_CODES = [
  "BAD_REQUEST", "INTERNAL_ERROR", "ML_NOT_CONFIGURED", "UNAUTHORIZED",
  "STORAGE_UNAVAILABLE", "ARTIFACT_UNAVAILABLE", "MODEL_NOT_FOUND", "FEATURE_VERSION_UNSUPPORTED",
  "TRAINING_NOT_PERMITTED", "MIXED_DATASET", "STALE_REVISION", "SPLIT_CONFLICT", "DUPLICATE_EXAMPLE",
  "DECISION_CONFLICT", "EXPOSURE_CONFLICT", "IDEMPOTENCY_CONFLICT", "UNKNOWN_DECISION", "EXPOSURE_NOT_FOUND",
  "POLICY_EXPOSURE_NOT_FOUND", "NO_ELIGIBLE_CANDIDATES", "POLICY_STATE_UNAVAILABLE", "STALE_FIT_RECEIPT",
] as const;
type UpstreamErrorCode = typeof UPSTREAM_ERROR_CODES[number];
export type MlClientErrorCode = UpstreamErrorCode | "ML_INVALID_CONFIG" | "ML_INVALID_REQUEST"
  | "ML_TIMEOUT" | "ML_UNAVAILABLE" | "ML_INVALID_RESPONSE" | "ML_HTTP_ERROR";

/** Safe to classify or serialize; never retains response bodies, URLs, credentials, or causes. */
export class MlClientError extends Error {
  constructor(readonly code: MlClientErrorCode, readonly status: number, readonly retryable: boolean) {
    super("The ML service request failed.");
    this.name = "MlClientError";
  }
}

function invalidResponse(): MlClientError {
  return new MlClientError("ML_INVALID_RESPONSE", 502, false);
}

function parse<S extends z.ZodType>(schema: S, input: unknown, request = false): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw request ? new MlClientError("ML_INVALID_REQUEST", 400, false) : invalidResponse();
  return result.data;
}

function railwayPrivateOrigin(value: string, url: URL): boolean {
  // Check raw origin syntax too: URL normalizes encoded hosts, dot paths and backslashes.
  if (!/^http:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(value)
    || url.hostname.length > 253 || url.port === "0") return false;
  const labels = url.hostname.split(".");
  return labels.length >= 3 && labels.at(-2) === "railway" && labels.at(-1) === "internal"
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function serviceBaseUrl(value: string, allowRailwayPrivateHttp: boolean): URL {
  try {
    if (typeof value !== "string" || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error();
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    const railwayPrivate = allowRailwayPrivateHttp && railwayPrivateOrigin(value, url);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || railwayPrivate)))
      || url.username || url.password || value.includes("?") || value.includes("#")) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
  } catch {
    throw new MlClientError("ML_INVALID_CONFIG", 500, false);
  }
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status !== 501 && status !== 505);
}

function httpError(status: number, body: unknown): MlClientError {
  const envelope = ErrorEnvelopeSchema.safeParse(body);
  const known = envelope.success && (UPSTREAM_ERROR_CODES as readonly string[]).includes(envelope.data.code);
  return new MlClientError(
    known ? envelope.data.code as UpstreamErrorCode : "ML_HTTP_ERROR",
    status,
    transientStatus(status) && (!envelope.success || envelope.data.retryable !== false),
  );
}

function checkFit(request: FitRequest, response: FitResponse): boolean {
  const holdout = request.examples.filter(example => example.split === "holdout");
  const eligibleTrain = request.examples.filter(example => example.split === "train" && example.features.permittedForTraining).length;
  const positive = holdout.filter(example => example.label === 1).length;
  return response.userId === request.userId
    && response.featureVersion === request.featureVersion
    && response.feedbackRevision === request.feedbackRevision
    && response.modelVersion === response.metrics.modelVersion
    && response.trainedExamples === response.metrics.trainedExamples
    && response.trainedExamples <= eligibleTrain
    && response.metrics.labeledExamples === request.examples.length
    && response.metrics.heldOutExamples === holdout.length
    && response.metrics.heldOutPositive === positive
    && response.metrics.heldOutNegative === holdout.length - positive;
}

function checkScore(request: ScoreRequest, response: ScoreResponse): boolean {
  if (response.userId !== request.userId || response.featureVersion !== request.featureVersion
    || response.modelVersion.length === 0 || (request.modelVersion !== null && request.modelVersion !== response.modelVersion)
    || response.predictions.length !== request.candidates.length) return false;
  const remaining = new Map<string, number>();
  for (const candidate of request.candidates) remaining.set(candidate.trackId, (remaining.get(candidate.trackId) ?? 0) + 1);
  for (const { trackId, prediction } of response.predictions) {
    const count = remaining.get(trackId) ?? 0;
    if (count === 0 || prediction.modelVersion !== response.modelVersion || prediction.featureVersion !== response.featureVersion) return false;
    remaining.set(trackId, count - 1);
  }
  return true;
}

/** HTTPS/loopback preserve base paths. Railway private HTTP requires an explicit origin-only opt-in. */
export interface MlClientOptions {
  serviceUrl: string; sharedSecret: string; fetch?: MlFetch; timeoutMs?: number;
  /** Enable only for Railway's encrypted, isolated private network. Defaults to false. */
  allowRailwayPrivateHttp?: boolean;
}

function createTransport(options: MlClientOptions) {
  const { allowRailwayPrivateHttp = false } = options;
  if (typeof allowRailwayPrivateHttp !== "boolean") throw new MlClientError("ML_INVALID_CONFIG", 500, false);
  const base = serviceBaseUrl(options.serviceUrl, allowRailwayPrivateHttp);
  const { sharedSecret } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Visible ASCII tokens avoid whitespace/header injection and invalid header encodings.
  if (typeof sharedSecret !== "string" || !/^[\x21-\x7e]+$/.test(sharedSecret)
    || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || (options.fetch !== undefined && typeof options.fetch !== "function")) {
    throw new MlClientError("ML_INVALID_CONFIG", 500, false);
  }
  const fetcher = options.fetch ?? globalThis.fetch;

  async function send<S extends z.ZodType>(
    route: { method: "GET" | "POST"; path: string; response: S },
    payload: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<z.output<S>> {
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/+$/, "")}${route.path}`;
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MlClientError("ML_TIMEOUT", 504, true));
      }, timeoutMs);
    });

    // A single attempt: callers own revision/exposure idempotency and retry policy.
    const exchange = async (): Promise<z.output<S>> => {
      const response = await fetcher(url, {
        method: route.method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${sharedSecret}`, Accept: "application/json", ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(route.method === "POST" ? { body: JSON.stringify(payload) } : {}),
      });
      let body: unknown;
      try { body = await response.json(); } catch {
        if (controller.signal.aborted) throw new MlClientError("ML_TIMEOUT", 504, true);
        if (!response.ok) throw httpError(response.status, undefined);
        throw invalidResponse();
      }
      if (!response.ok) throw httpError(response.status, body);
      return parse(route.response, body);
    };

    try {
      // Race also covers injected fetch/body readers which ignore AbortSignal.
      return await Promise.race([exchange(), timeout]);
    } catch (error) {
      if (controller.signal.aborted) throw new MlClientError("ML_TIMEOUT", 504, true);
      if (error instanceof MlClientError) throw error;
      throw new MlClientError("ML_UNAVAILABLE", 503, true);
    } finally {
      clearTimeout(timer);
    }
  }

  return send;
}

export function createMlClient(options: MlClientOptions): MlClient {
  const send = createTransport(options);
  return {
    async fit(input) {
      const request = parse(INTERNAL_ROUTES.fit.body, input, true);
      const response = await send(INTERNAL_ROUTES.fit, request);
      if (!checkFit(request, response)) throw invalidResponse();
      return response;
    },
    async score(input) {
      const request = parse(INTERNAL_ROUTES.score.body, input, true);
      const response = await send(INTERNAL_ROUTES.score, request);
      if (!checkScore(request, response)) throw invalidResponse();
      return response;
    },
    async observe(input) {
      const request = parse(INTERNAL_ROUTES.observe.body, input, true);
      const response = await send(INTERNAL_ROUTES.observe, request);
      if (response.feedbackRevision !== request.feedbackRevision) throw invalidResponse();
      return response;
    },
    async evaluation(input) {
      const query = parse(EvaluationQuerySchema, input, true);
      const response = await send(INTERNAL_ROUTES.evaluation, undefined, query);
      // Frozen ModelMetrics has no user ID to cross-check; the request stays owner-scoped.
      if (query.modelVersion !== undefined && response.modelVersion !== query.modelVersion) throw invalidResponse();
      return response;
    },
    async explain(input) {
      const query = parse(ExplainQuerySchema, input, true);
      const response = await send(INTERNAL_ROUTES.explain, undefined, query);
      if (response.exposureId !== query.exposureId) throw invalidResponse();
      return response;
    },
  };
}


/** Private policy transport; feedback uses association only, never fit or observe. */
export interface PolicyClient {
  select(request: PolicySelectRequest): Promise<PolicyDecision>;
  exposure(query: {userId: string; exposureId: string}): Promise<PolicyExposure>;
  release(request: PolicyReleaseRequest): Promise<PolicyReleaseReceipt>;
  associate(request: PolicyAssociationRequest): Promise<PolicyAssociationReceipt>;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

export function createPolicyClient(options: MlClientOptions): PolicyClient {
  const send = createTransport(options);
  return {
    async select(input) {
      const request = parse(INTERNAL_ROUTES.policySelect.body, input, true);
      // Legacy C2 requests may omit the revision; this integration never may.
      if (request.modelVersion === null || request.feedbackRevision === undefined) {
        throw new MlClientError('ML_INVALID_REQUEST', 400, false);
      }
      const response = await send(INTERNAL_ROUTES.policySelect, request);
      const candidate = request.candidates.find(row => row.trackId === response.trackId);
      const ids = new Set(request.candidates.map(row => row.trackId));
      if (response.userId !== request.userId || response.exposureId !== request.exposureId
        || response.modelVersion !== request.modelVersion || response.feedbackRevision !== request.feedbackRevision
        || response.featureVersion !== request.featureVersion || response.seed !== request.seed
        || !sameValue(response.config, request.config) || !sameValue(response.candidate, candidate)
        || response.candidateCount !== ids.size || response.candidateTrackIds.some(id => !ids.has(id))
        || response.selection.index >= response.availableCount || response.selection.eligibleCount < 1
        || !ids.has(response.selection.greedyTrackId)
        || ![request.config.strategy, 'c1'].includes(response.selection.selectionMethod)
        || response.contextNames.length !== response.selection.context.length) throw invalidResponse();
      return response;
    },
    async exposure(input) {
      const query = parse(INTERNAL_ROUTES.policyExposure.query, input, true);
      const response = await send(INTERNAL_ROUTES.policyExposure, undefined, query);
      if (response.decision.userId !== query.userId || response.decision.exposureId !== query.exposureId
        || response.reservation.exposureId !== query.exposureId) throw invalidResponse();
      return response;
    },
    async release(input) {
      const request = parse(INTERNAL_ROUTES.policyRelease.body, input, true);
      const response = await send(INTERNAL_ROUTES.policyRelease, request);
      if (response.userId !== request.userId || response.requestId !== request.requestId
        || response.exposureId !== request.exposureId
        || Date.parse(response.effectiveClosedAt) > Date.parse(response.expiresAt)
        || (response.outcome === 'released' && Date.parse(response.effectiveClosedAt) > Date.parse(response.recordedAt))) throw invalidResponse();
      return response;
    },
    async associate(input) {
      const request = parse(INTERNAL_ROUTES.policyAssociate.body, input, true);
      const response = await send(INTERNAL_ROUTES.policyAssociate, request);
      if (response.userId !== request.userId || response.eventId !== request.event.eventId
        || response.sequence !== request.event.sequence
        || response.fitReceipt.modelVersion !== request.fitReceipt.modelVersion
        || response.fitReceipt.synchronizedFeedbackRevision !== request.fitReceipt.synchronizedFeedbackRevision
        || (response.eligibleForLearning && (request.event.operation === 'revoke' || request.event.label === null
          || !request.event.features.permittedForTraining))) {
        throw invalidResponse();
      }
      return response;
    },
  };
}
