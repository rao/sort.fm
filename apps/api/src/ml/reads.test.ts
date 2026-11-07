import { afterEach, expect, test } from "bun:test";
import { FEATURE_VERSION, ErrorEnvelopeSchema, PUBLIC_ROUTES, type AudioFeatureStatus, type LibrarySummary, type ModelMetrics, type ModelRunInput } from "@sortfm/contracts";
import { buildApp } from "../app";
import { loadConfig } from "../config";
import { createMlReadModule } from "./reads";

const userId = "spotify:owner";
const config = loadConfig({ NODE_ENV: "test" });
const metrics: ModelMetrics = {
  status: "available", reason: null, modelVersion: "c1-r50-read-test", dataset: "user_feedback", evaluationMethod: "fixed_holdout",
  labeledExamples: 50, trainedExamples: 30, heldOutExamples: 20, heldOutPositive: 5, heldOutNegative: 15,
  baseRate: 0.25, balancedAccuracy: 0.7, rocAuc: 0.8, prAuc: 0.6, logLoss: 0.4, brierScore: 0.1, precisionAtK: 0.5,
  evaluatedAt: "2026-11-07T12:00:00Z",
};
const library: LibrarySummary = { total: 100, reviewed: 60, remaining: 70, archived: 12, unliked: 8, kept: 40, skipped: 9 };
const audio: AudioFeatureStatus = {
  provider: "soundnet", status: "running", featuresReady: 17, featuresTotal: 100, failed: 2,
  missingness: { energy: 0.1, happiness: 0.7 }, reason: null,
};
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const sensitive = "private-access-token-and-database-path";
const paths = [PUBLIC_ROUTES.insights.path, PUBLIC_ROUTES.analytics.path] as const;
const headers = { cookie: "sortfm_session=valid" };
const storedModel: ModelRunInput = {
  runId: "10000000-0000-4000-8000-000000000001", userId, modelVersion: metrics.modelVersion,
  modelKind: "logistic", featureVersion: FEATURE_VERSION, artifactPath: `/private/${sensitive}/model.joblib`,
  trainedExamples: 30, feedbackRevision: 50, metrics, createdAt: "2026-11-07T12:00:00Z",
};
type ReadOptions = Parameters<typeof createMlReadModule>[0];

async function setup(overrides: Partial<ReadOptions> = {}, production = false) {
  const appConfig = production ? loadConfig({ NODE_ENV: "production" }) : config;
  const calls = { summary: [] as string[], audio: [] as string[], evaluation: [] as { userId: string; modelVersion?: string }[], latest: [] as string[] };
  const options: ReadOptions = {
    config: { ...appConfig, secureCookies: production },
    auth: { session: async token => token === "valid" ? { user: { id: userId } } : null },
    getSummary: async owner => { calls.summary.push(owner); return library; },
    audioProgress: async owner => { calls.audio.push(owner); return audio; },
    ml: { evaluation: async (owner, modelVersion) => { calls.evaluation.push({ userId: owner, ...(modelVersion === undefined ? {} : { modelVersion }) }); return metrics; } },
    latestModel: async owner => { calls.latest.push(owner); return storedModel; },
    ...overrides,
  };
  const module = createMlReadModule(options);
  const app = await buildApp({ config: appConfig, registerRoutes: module.registerRoutes }); apps.push(app);
  return { app, calls, options };
}

function expectSafeError(response: { statusCode: number; body: string; json(): unknown }, status = 503, code?: string) {
  expect(response.statusCode).toBe(status);
  const parsed = ErrorEnvelopeSchema.parse(response.json());
  if (code) expect(parsed.code).toBe(code);
  expect(response.body).not.toContain(sensitive);
  expect(response.body).not.toContain("artifactPath");
  expect(response.body).not.toContain("stack");
}

function expectUnavailableMetrics(actual: ModelMetrics) {
  const { reason, ...fields } = actual;
  const { reason: _originalReason, ...expectedFields } = metrics;
  expect(fields).toEqual({
    ...expectedFields, status: "unavailable",
    baseRate: null, balancedAccuracy: null, rocAuc: null, prAuc: null, logLoss: null, brierScore: null, precisionAtK: null,
  });
  expect(typeof reason).toBe("string");
  expect(reason?.length ?? 0).toBeGreaterThan(0);
  expect(JSON.stringify(actual)).not.toContain(sensitive);
}

test("public insights serves actual owner-scoped metrics and audio with no invented prediction", async () => {
  const module = createMlReadModule({
    config: { ...config, secureCookies: false }, auth: { session: async token => token === "valid" ? { user: { id: userId } } : null },
    getSummary: async () => library, audioProgress: async () => audio, ml: { evaluation: async () => metrics },
  });
  const app = await buildApp({ config, registerRoutes: module.registerRoutes }); apps.push(app);
  const response = await app.inject({ url: PUBLIC_ROUTES.insights.path, headers: { cookie: "sortfm_session=valid" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ prediction: null, metrics, audioFeatures: audio });
  expect(PUBLIC_ROUTES.insights.response.safeParse(response.json()).success).toBe(true);
});

test("analytics preserves actual non-additive library counts and performs only necessary owner reads", async () => {
  const { app, calls } = await setup();
  const response = await app.inject({ url: PUBLIC_ROUTES.analytics.path, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ library, metrics });
  expect(PUBLIC_ROUTES.analytics.response.safeParse(response.json()).success).toBe(true);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(calls).toEqual({ summary: [userId], audio: [], evaluation: [{ userId }], latest: [] });
  expect(response.json().library.total).not.toBe(response.json().library.reviewed + response.json().library.remaining);
});

test("insights reads only evaluation and actual audio for the session owner", async () => {
  const { app, calls } = await setup();
  const response = await app.inject({ url: PUBLIC_ROUTES.insights.path, headers: { ...headers, "x-user-id": "spotify:forged" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ prediction: null, metrics, audioFeatures: audio });
  expect(calls).toEqual({ summary: [], audio: [userId], evaluation: [{ userId }], latest: [] });
});

test.each(paths)("%s rejects anonymous, forged, duplicated, and malformed session cookies before data reads", async path => {
  const { app, calls } = await setup();
  for (const cookie of [undefined, "sortfm_session=forged", "sortfm_session=valid; sortfm_session=forged", "sortfm_session=valid; sortfm_session=valid", "sortfm_session=%E0%A4%A", "sortfm_session", "__Host-sortfm_session=valid"]) {
    const response = await app.inject({ url: path, headers: cookie ? { cookie } : {} });
    expectSafeError(response, 401, "AUTHENTICATION_REQUIRED");
  }
  expect(calls).toEqual({ summary: [], audio: [], evaluation: [], latest: [] });
});

test.each(paths)("%s requires the production __Host cookie and ignores an insecure cookie", async path => {
  const { app, calls } = await setup({}, true);
  expectSafeError(await app.inject({ url: path, headers }), 401, "AUTHENTICATION_REQUIRED");
  expectSafeError(await app.inject({ url: path, headers: { cookie: "__Host-sortfm_session=valid; __Host-sortfm_session=forged" } }), 401, "AUTHENTICATION_REQUIRED");
  const response = await app.inject({ url: path, headers: { cookie: "__Host-sortfm_session=valid" } });
  expect(response.statusCode).toBe(200);
  expect(calls.evaluation).toEqual([{ userId }]);
});

test.each(paths)("%s rejects a foreign origin before data reads", async path => {
  const { app, calls } = await setup();
  expectSafeError(await app.inject({ url: path, headers: { ...headers, origin: "https://foreign.example" } }), 403, "ORIGIN_NOT_ALLOWED");
  expect(calls).toEqual({ summary: [], audio: [], evaluation: [], latest: [] });
});

test.each(paths)("%s rejects query-controlled identity, model version, and other unexpected inputs", async path => {
  const { app, calls } = await setup();
  for (const query of ["userId=spotify:forged", "modelVersion=other-user-model", "mode=demo", "userId=spotify:owner&userId=spotify:forged"]) {
    expectSafeError(await app.inject({ url: `${path}?${query}`, headers }), 400, "VALIDATION_ERROR");
  }
  expect(calls).toEqual({ summary: [], audio: [], evaluation: [], latest: [] });
});

test.each(paths)("%s rejects a GET payload attempting to override the session identity", async path => {
  const { app, calls } = await setup();
  const response = await app.inject({ method: "GET", url: path, headers: { ...headers, "content-type": "application/json" }, payload: { userId: "spotify:forged" } });
  expectSafeError(response, 400);
  expect(calls).toEqual({ summary: [], audio: [], evaluation: [], latest: [] });
});

test("public reads never call fit, score, observe, explain, or mutation dependencies", async () => {
  const writes: string[] = [];
  const unused = async (name: string) => { writes.push(name); throw new Error(`Unexpected ${name}`); };
  const ml = {
    evaluation: async () => metrics,
    fit: () => unused("fit"), score: () => unused("score"), observe: () => unused("observe"), explain: () => unused("explain"),
  };
  const { app } = await setup({ ml });
  for (const path of paths) expect((await app.inject({ url: path, headers })).statusCode).toBe(200);
  expect(writes).toEqual([]);
  expectSafeError(await app.inject({ method: "POST", url: PUBLIC_ROUTES.retrain.path, headers, payload: {} }), 501, "NOT_IMPLEMENTED");
  expect(writes).toEqual([]);
});

test.each(paths)("%s uses a validated stored model only after ML is unavailable", async path => {
  const before = structuredClone(storedModel);
  const { app, calls } = await setup({ ml: { evaluation: async () => { throw new Error(sensitive); } } });
  const response = await app.inject({ url: path, headers });
  expect(response.statusCode).toBe(200);
  expectUnavailableMetrics(response.json().metrics);
  expect(calls.latest).toEqual([userId]);
  expect(storedModel).toEqual(before);
  expect(response.body).not.toContain("artifactPath");
  expect(response.body).not.toContain(sensitive);
  if (path === PUBLIC_ROUTES.insights.path) {
    expect(response.json().prediction).toBeNull();
    expect(response.json().audioFeatures).toEqual(audio);
    expect(PUBLIC_ROUTES.insights.response.safeParse(response.json()).success).toBe(true);
  } else {
    expect(response.json().library).toEqual(library);
    expect(PUBLIC_ROUTES.analytics.response.safeParse(response.json()).success).toBe(true);
  }
});

test("disabled ML can return validated stored identity and counts without reporting stale metrics as current", async () => {
  const { app, calls } = await setup({ ml: null });
  const response = await app.inject({ url: PUBLIC_ROUTES.insights.path, headers });
  expect(response.statusCode).toBe(200);
  expectUnavailableMetrics(response.json().metrics);
  expect(calls.latest).toEqual([userId]);
  expect(calls.evaluation).toEqual([]);
});

test("invalid live metrics use a validated stored model rather than leaking a schema error to the browser", async () => {
  const { app } = await setup({ ml: { evaluation: async () => ({ ...metrics, balancedAccuracy: 9, reason: sensitive }) } });
  const response = await app.inject({ url: PUBLIC_ROUTES.insights.path, headers });
  expect(response.statusCode).toBe(200);
  expectUnavailableMetrics(response.json().metrics);
});

test("ML timeout permits a separately bounded validated stored fallback", async () => {
  const { app, calls } = await setup({ readTimeoutMs: 15, ml: { evaluation: () => new Promise<ModelMetrics>(() => {}) } });
  const response = await app.inject({ url: PUBLIC_ROUTES.insights.path, headers });
  expect(response.statusCode).toBe(200);
  expectUnavailableMetrics(response.json().metrics);
  expect(calls.latest).toEqual([userId]);
}, 1000);

test("a late ML rejection after timeout is contained", async () => {
  const { app } = await setup({ readTimeoutMs: 10, ml: { evaluation: () => new Promise<ModelMetrics>((_resolve, reject) => setTimeout(() => reject(new Error(sensitive)), 40)) } });
  const response = await app.inject({ url: PUBLIC_ROUTES.analytics.path, headers });
  expect(response.statusCode).toBe(200);
  expectUnavailableMetrics(response.json().metrics);
  await Bun.sleep(50);
}, 1000);

test.each(paths)("%s returns sanitized 503 when no live or stored model exists", async path => {
  const { app } = await setup({ ml: null, latestModel: async () => null });
  expectSafeError(await app.inject({ url: path, headers }));
});

test.each(paths)("%s returns sanitized 503 when fallback is not configured", async path => {
  const { app } = await setup({ ml: { evaluation: async () => { throw new Error(sensitive); } }, latestModel: undefined });
  expectSafeError(await app.inject({ url: path, headers }));
});

test.each([
  { ...storedModel, userId: "spotify:someone-else" },
  { ...storedModel, modelVersion: "different-model" },
  { ...storedModel, trainedExamples: 29 },
  { ...storedModel, featureVersion: "unsupported" },
  { ...storedModel, metrics: { ...metrics, heldOutNegative: 99 } },
  { ...storedModel, metrics: { ...metrics, labeledExamples: -1 } },
  { ...storedModel, artifactPath: undefined },
])("rejects malformed or cross-user stored fallback %# with a sanitized 503", async stored => {
  const { app } = await setup({ ml: null, latestModel: async () => stored as ModelRunInput });
  expectSafeError(await app.inject({ url: PUBLIC_ROUTES.insights.path, headers }));
});

test.each(["summary", "audio", "stored"] as const)("bounds a stalled %s dependency and returns 503 without synthetic defaults", async dependency => {
  const overrides: Partial<ReadOptions> = { readTimeoutMs: 15 };
  if (dependency === "summary") overrides.getSummary = () => new Promise<LibrarySummary>(() => {});
  if (dependency === "audio") overrides.audioProgress = () => new Promise<AudioFeatureStatus>(() => {});
  if (dependency === "stored") { overrides.ml = null; overrides.latestModel = () => new Promise<ModelRunInput | null>(() => {}); }
  const { app } = await setup(overrides);
  const response = await app.inject({ url: dependency === "summary" ? PUBLIC_ROUTES.analytics.path : PUBLIC_ROUTES.insights.path, headers });
  expectSafeError(response);
  expect(response.json()).not.toHaveProperty("metrics");
  expect(response.json()).not.toHaveProperty("audioFeatures");
  expect(response.json()).not.toHaveProperty("library");
}, 1000);

test.each([
  { ...library, total: -1 }, { ...library, remaining: Number.NaN }, { ...library, total: undefined }, { ...library, extra: sensitive },
])("invalid summary dependency data is an upstream 503, never a caller validation error %#", async badLibrary => {
  const { app } = await setup({ getSummary: async () => badLibrary as LibrarySummary });
  expectSafeError(await app.inject({ url: PUBLIC_ROUTES.analytics.path, headers }));
});

test.each([
  { ...audio, featuresReady: -1 }, { ...audio, missingness: { energy: 3 } }, { ...audio, provider: "unknown" }, { ...audio, extra: sensitive },
])("invalid audio dependency data is an upstream 503, never a caller validation error %#", async badAudio => {
  const { app } = await setup({ audioProgress: async () => badAudio as AudioFeatureStatus });
  expectSafeError(await app.inject({ url: PUBLIC_ROUTES.insights.path, headers }));
});

test.each(["summary", "audio", "stored"] as const)("sanitizes %s read failures", async dependency => {
  const failed = async (): Promise<never> => { throw new Error(sensitive); };
  const overrides: Partial<ReadOptions> = dependency === "summary" ? { getSummary: failed }
    : dependency === "audio" ? { audioProgress: failed } : { ml: null, latestModel: failed };
  const { app } = await setup(overrides);
  expectSafeError(await app.inject({ url: dependency === "summary" ? PUBLIC_ROUTES.analytics.path : PUBLIC_ROUTES.insights.path, headers }));
});

test.each([0, -1, Number.NaN, Infinity, 0.5, 2 ** 31])("rejects invalid read timeout configuration %j", readTimeoutMs => {
  expect(() => createMlReadModule({
    config: { ...config, secureCookies: false }, auth: { session: async () => null },
    getSummary: async () => library, audioProgress: async () => audio, ml: null, readTimeoutMs,
  })).toThrow();
});
