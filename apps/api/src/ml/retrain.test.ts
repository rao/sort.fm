import { afterEach, expect, test } from "bun:test";
import { FEATURE_VERSION, ErrorEnvelopeSchema, FitResponseSchema, PUBLIC_ROUTES, type FitResponse, type ModelMetrics } from "@sortfm/contracts";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import { createMlRetrainModule } from "./retrain";
import { MlClientError } from "./client";

const config = loadConfig({ NODE_ENV: "test" });
const userId = "spotify:owner";
const metrics: ModelMetrics = {
  status: "available", reason: null, modelVersion: "c1-r50-retrain-test", dataset: "user_feedback", evaluationMethod: "fixed_holdout",
  labeledExamples: 50, trainedExamples: 30, heldOutExamples: 20, heldOutPositive: 5, heldOutNegative: 15,
  baseRate: 0.25, balancedAccuracy: 0.7, rocAuc: 0.8, prAuc: 0.6, logLoss: 0.4, brierScore: 0.1, precisionAtK: 0.5,
  evaluatedAt: "2026-11-07T12:00:00Z",
};
const fitResponse: FitResponse = {
  userId, modelVersion: metrics.modelVersion, featureVersion: FEATURE_VERSION,
  feedbackRevision: 50, trainedExamples: 30, metrics,
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const headers = { cookie: "sortfm_session=valid", origin: config.webOrigin };
const sensitive = "private-upstream-secret-model-path";
type RetrainOptions = Parameters<typeof createMlRetrainModule>[0];

async function setup(overrides: Partial<RetrainOptions> = {}, production = false) {
  const appConfig = production ? loadConfig({ NODE_ENV: "production" }) : config;
  const fittedUsers: string[] = [];
  const module = createMlRetrainModule({
    config: { ...appConfig, secureCookies: production },
    auth: { session: async token => token === "valid" ? { user: { id: userId } } : null },
    ml: { fit: async owner => { fittedUsers.push(owner); return fitResponse; } },
    ...overrides,
  });
  const app = await buildApp({ config: appConfig, registerRoutes: module.registerRoutes }); apps.push(app);
  return { app, fittedUsers, appConfig };
}

function expectSafeError(response: { statusCode: number; body: string; json(): unknown }, status: number, code?: string, retryable?: boolean) {
  expect(response.statusCode).toBe(status);
  const error = ErrorEnvelopeSchema.parse(response.json());
  if (code) expect(error.code).toBe(code);
  if (retryable !== undefined) expect(error.retryable).toBe(retryable);
  expect(response.body).not.toContain(sensitive);
  expect(response.body).not.toContain("stack");
  expect(response.json()).not.toHaveProperty("metrics");
  return error;
}

function expectAmbiguousFailure(response: Parameters<typeof expectSafeError>[0], status: number, code?: string) {
  const error = expectSafeError(response, status, code, false);
  expect(error.message.toLowerCase()).toMatch(/may (?:(?:still|have) )?(?:finish|complete)/);
  expect(error.message.toLowerCase()).toContain("refresh");
  return error;
}

test("explicit retrain fits the session owner once and returns the actual fit response", async () => {
  const fittedUsers: string[] = [];
  const module = createMlRetrainModule({
    config: { ...config, secureCookies: false },
    auth: { session: async token => token === "valid" ? { user: { id: userId } } : null },
    ml: { fit: async owner => { fittedUsers.push(owner); return fitResponse; } },
  });
  const app = await buildApp({ config, registerRoutes: module.registerRoutes }); apps.push(app);
  const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(fitResponse);
  expect(FitResponseSchema.safeParse(response.json()).success).toBe(true);
  expect(fittedUsers).toEqual([userId]);
});

test("absent body is allowed and responses are private and not cached", async () => {
  const { app, fittedUsers } = await setup();
  const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(fitResponse);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(fittedUsers).toEqual([userId]);
});

test("anonymous, forged, duplicated, and malformed cookies never trigger a fit", async () => {
  const { app, fittedUsers } = await setup();
  for (const cookie of [undefined, "sortfm_session=forged", "sortfm_session=valid; sortfm_session=forged", "sortfm_session=valid; sortfm_session=valid", "sortfm_session=%E0%A4%A", "sortfm_session", "__Host-sortfm_session=valid"]) {
    const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { origin: config.webOrigin, ...(cookie ? { cookie } : {}) }, payload: {} });
    expectSafeError(response, 401, "AUTHENTICATION_REQUIRED");
  }
  expect(fittedUsers).toEqual([]);
});

test("production requires an unambiguous __Host session cookie", async () => {
  const { app, fittedUsers, appConfig } = await setup({}, true);
  for (const cookie of ["sortfm_session=valid", "__Host-sortfm_session=valid; __Host-sortfm_session=forged"]) {
    expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { cookie, origin: appConfig.webOrigin }, payload: {} }), 401, "AUTHENTICATION_REQUIRED");
  }
  const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { cookie: "__Host-sortfm_session=valid", origin: appConfig.webOrigin }, payload: {} });
  expect(response.statusCode).toBe(200);
  expect(fittedUsers).toEqual([userId]);
});

test("missing, foreign, and explicitly cross-site origins are rejected before fit", async () => {
  const { app, fittedUsers } = await setup();
  for (const requestHeaders of [
    { cookie: headers.cookie },
    { ...headers, origin: "https://attacker.example" },
    { ...headers, "sec-fetch-site": "cross-site" },
  ]) {
    expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: requestHeaders, payload: {} }), 403);
  }
  expect(fittedUsers).toEqual([]);
});

test("the configured API origin can request a fit with its valid owner session", async () => {
  const { app, fittedUsers } = await setup();
  expect((await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { ...headers, origin: config.apiOrigin }, payload: {} })).statusCode).toBe(200);
  expect(fittedUsers).toEqual([userId]);
});

test.each(["userId=spotify:other", "modelVersion=other", "feedbackRevision=99", "mode=demo", "userId=spotify:owner&userId=spotify:other"])("rejects query override %s before fit", async query => {
  const { app, fittedUsers } = await setup();
  expectSafeError(await app.inject({ method: "POST", url: `${PUBLIC_ROUTES.retrain.path}?${query}`, headers, payload: {} }), 400, "VALIDATION_ERROR");
  expect(fittedUsers).toEqual([]);
});

test.each([
  "null", '"text"', "[]", "[{}]", "0", "false", '{"userId":"spotify:other"}', '{"labels":[1]}',
  '{"examples":[]}', '{"feedbackRevision":999}', '{"evaluationSeed":123}', '{"featureVersion":"unsupported"}',
])("rejects nonempty or non-object request body %s before fit", async payload => {
  const { app, fittedUsers } = await setup();
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { ...headers, "content-type": "application/json" }, payload }), 400, "VALIDATION_ERROR");
  expect(fittedUsers).toEqual([]);
});

test("malformed JSON is a safe request error and never fits", async () => {
  const { app, fittedUsers } = await setup();
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { ...headers, "content-type": "application/json" }, payload: `{"${sensitive}` }), 400);
  expect(fittedUsers).toEqual([]);
});

test("two sessions fit only their own server-side user identity", async () => {
  const fittedUsers: string[] = [];
  const { app } = await setup({
    auth: { session: async token => token === "first" ? { user: { id: "spotify:first" } } : token === "second" ? { user: { id: "spotify:second" } } : null },
    ml: { fit: async owner => { fittedUsers.push(owner); return { ...fitResponse, userId: owner }; } },
  });
  for (const [token, owner] of [["first", "spotify:first"], ["second", "spotify:second"]]) {
    const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { ...headers, cookie: `sortfm_session=${token}`, "x-user-id": "spotify:forged" }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().userId).toBe(owner);
  }
  expect(fittedUsers).toEqual(["spotify:first", "spotify:second"]);
});

test.each([
  { ...fitResponse, userId: "spotify:other" },
  { ...fitResponse, modelVersion: "other-model" },
  { ...fitResponse, trainedExamples: 29 },
  { ...fitResponse, featureVersion: "unsupported" },
  { ...fitResponse, metrics: { ...metrics, trainedExamples: 29 } },
  { ...fitResponse, metrics: { ...metrics, rocAuc: 9 } },
  { ...fitResponse, feedbackRevision: -1 },
  { ...fitResponse, secret: sensitive },
  {}, null,
])("rejects malformed or incoherent fit response %# with safe 502", async result => {
  let calls = 0;
  const { app } = await setup({ ml: { fit: async () => { calls++; return result as FitResponse; } } });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 502, "ML_INVALID_RESPONSE", false);
  expect(calls).toBe(1);
});

test("disabled ML returns explicit unavailable after authentication", async () => {
  const { app } = await setup({ ml: null });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 503, "ML_UNAVAILABLE");
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers: { origin: config.webOrigin }, payload: {} }), 401, "AUTHENTICATION_REQUIRED");
});

test("preserves a known stale-revision conflict with a safe 409 and no retry", async () => {
  let calls = 0;
  const { app } = await setup({ ml: { fit: async () => { calls++; throw new MlClientError("STALE_REVISION", 409, false); } } });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 409, "STALE_REVISION", false);
  expect(calls).toBe(1);
});

test.each([
  new Error(sensitive),
  new MlClientError("STORAGE_UNAVAILABLE", 503, true),
  new MlClientError("UNAUTHORIZED", 401, false),
  { code: sensitive, status: 503, message: sensitive, retryable: true },
])("generic upstream failure is sanitized and warns that a fit may still finish %#", async upstreamError => {
  let calls = 0;
  const { app } = await setup({ ml: { fit: async () => { calls++; throw upstreamError; } } });
  expectAmbiguousFailure(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 503);
  expect(calls).toBe(1);
});

test("a transport response validation error remains a safe terminal 502", async () => {
  const { app } = await setup({ ml: { fit: async () => { throw new MlClientError("ML_INVALID_RESPONSE", 502, false); } } });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 502, "ML_INVALID_RESPONSE", false);
});

test("an ML transport timeout is an ambiguous retrain timeout without automatic retry", async () => {
  let calls = 0;
  const { app } = await setup({ ml: { fit: async () => { calls++; throw new MlClientError("ML_TIMEOUT", 504, true); } } });
  expectAmbiguousFailure(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 504, "ML_RETRAIN_TIMEOUT");
  expect(calls).toBe(1);
});

test("fit deadline returns ambiguous 504 and never retries the operation", async () => {
  let calls = 0;
  const { app } = await setup({ timeoutMs: 15, ml: { fit: () => { calls++; return new Promise<FitResponse>(() => {}); } } });
  expectAmbiguousFailure(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 504, "ML_RETRAIN_TIMEOUT");
  expect(calls).toBe(1);
}, 1000);

test("authentication shares the deadline and a late session cannot trigger a fit", async () => {
  const { app, fittedUsers } = await setup({ timeoutMs: 10, auth: { session: () => new Promise(resolve => setTimeout(() => resolve({ user: { id: userId } }), 40)) } });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 503, "AUTHENTICATION_UNAVAILABLE", true);
  await Bun.sleep(50);
  expect(fittedUsers).toEqual([]);
}, 1000);

test("a permanently stalled authentication read is bounded without invoking fit", async () => {
  const { app, fittedUsers } = await setup({ timeoutMs: 15, auth: { session: () => new Promise(() => {}) } });
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 503, "AUTHENTICATION_UNAVAILABLE", true);
  expect(fittedUsers).toEqual([]);
}, 1000);

test("authentication and fit consume one total deadline rather than independent full budgets", async () => {
  let calls = 0;
  const { app } = await setup({
    timeoutMs: 100,
    auth: { session: () => new Promise(resolve => setTimeout(() => resolve({ user: { id: userId } }), 60)) },
    ml: { fit: () => { calls++; return new Promise(resolve => setTimeout(() => resolve(fitResponse), 60)); } },
  });
  expectAmbiguousFailure(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 504, "ML_RETRAIN_TIMEOUT");
  await Bun.sleep(30);
  expect(calls).toBe(1);
}, 1000);

test("late fit completion cannot turn the timeout into a fabricated success or trigger another fit", async () => {
  let calls = 0;
  let completed = 0;
  const { app } = await setup({ timeoutMs: 10, ml: { fit: () => { calls++; return new Promise(resolve => setTimeout(() => { completed++; resolve(fitResponse); }, 40)); } } });
  const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} });
  expectAmbiguousFailure(response, 504, "ML_RETRAIN_TIMEOUT");
  await Bun.sleep(50);
  expect(calls).toBe(1);
  expect(completed).toBe(1);
  expect(response.statusCode).toBe(504);
}, 1000);

test("late fit rejection after timeout is contained without retry or leaking its message", async () => {
  let calls = 0;
  const { app } = await setup({ timeoutMs: 10, ml: { fit: () => { calls++; return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(sensitive)), 40)); } } });
  const response = await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} });
  expectAmbiguousFailure(response, 504, "ML_RETRAIN_TIMEOUT");
  await Bun.sleep(50);
  expect(calls).toBe(1);
  expect(response.body).not.toContain(sensitive);
}, 1000);

test("explicit retrain never observes, scores, acknowledges feedback, or records model rows", async () => {
  const unexpected: string[] = [];
  const forbidden = async (name: string): Promise<never> => { unexpected.push(name); throw new Error(name); };
  const { app } = await setup({ ml: {
    fit: async () => fitResponse,
    ...{ observe: () => forbidden("observe"), score: () => forbidden("score"), evaluation: () => forbidden("evaluation"), explain: () => forbidden("explain"), acknowledgeFeedback: () => forbidden("acknowledgeFeedback"), recordModelRun: () => forbidden("recordModelRun") },
  } });
  expect((await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} })).statusCode).toBe(200);
  expect(unexpected).toEqual([]);
});

test.each([0, -1, Number.NaN, Infinity, 0.5, 2 ** 31])("rejects invalid timeout configuration %j", timeoutMs => {
  expect(() => createMlRetrainModule({
    config: { ...config, secureCookies: false }, auth: { session: async () => null }, ml: null, timeoutMs,
  })).toThrow();
});
