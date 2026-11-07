import { afterEach, describe, expect, test } from "bun:test";
import { FEATURE_VERSION, type FitRequest, type FitResponse, type ModelMetrics, type ObserveRequest, type Prediction, type ScoreRequest, type ScoreResponse } from "@sortfm/contracts";
import { createMlClient, MlClientError, type MlClient } from "./client";

const secret = "private-test-secret";
const version = "c1-r4-example";
const exposureId = "10000000-0000-4000-8000-000000000001";
const features = { featureVersion: FEATURE_VERSION, provenance: "synthetic" as const, permittedForTraining: true, values: { energy: 0, saved_age_days: null } };
const prediction: Prediction = {
  modelKind: "heuristic", modelVersion: version, featureVersion: FEATURE_VERSION, trainedExamples: 2,
  removalProbability: null, heuristicScore: 0.5, uncertainty: null, uncertaintyMethod: "none", calibrated: false, explanations: [],
};
const metrics: ModelMetrics = {
  status: "insufficient_data", reason: "Too few labels", modelVersion: version, dataset: "synthetic", evaluationMethod: "fixed_holdout",
  labeledExamples: 4, trainedExamples: 2, heldOutExamples: 2, heldOutPositive: 1, heldOutNegative: 1,
  baseRate: null, balancedAccuracy: null, rocAuc: null, prAuc: null, logLoss: null, brierScore: null, precisionAtK: null, evaluatedAt: null,
};
const fitRequest: FitRequest = {
  userId: "demo:user", featureVersion: FEATURE_VERSION, feedbackRevision: 4, evaluationSeed: 42,
  examples: [
    { trackId: "demo:train-keep", features, decisionId: "20000000-0000-4000-8000-000000000001", label: 0, split: "train", labeledAt: "2026-11-07T12:00:00Z" },
    { trackId: "demo:train-remove", features, decisionId: "20000000-0000-4000-8000-000000000002", label: 1, split: "train", labeledAt: "2026-11-07T12:00:00Z" },
    { trackId: "demo:holdout-keep", features, decisionId: "20000000-0000-4000-8000-000000000003", label: 0, split: "holdout", labeledAt: "2026-11-07T12:00:00Z" },
    { trackId: "demo:holdout-remove", features, decisionId: "20000000-0000-4000-8000-000000000004", label: 1, split: "holdout", labeledAt: "2026-11-07T12:00:00Z" },
  ],
};
const fitResponse: FitResponse = { userId: "demo:user", featureVersion: FEATURE_VERSION, feedbackRevision: 4, modelVersion: version, trainedExamples: 2, metrics };
const scoreRequest: ScoreRequest = { userId: "demo:user", featureVersion: FEATURE_VERSION, modelVersion: null, candidates: [{ trackId: "demo:track", features, exposureId }] };
const scoreResponse: ScoreResponse = { userId: "demo:user", featureVersion: FEATURE_VERSION, modelVersion: version, predictions: [{ trackId: "demo:track", prediction }] };
const observeRequest: ObserveRequest = {
  userId: "demo:user", eventId: "30000000-0000-4000-8000-000000000001", decisionId: "20000000-0000-4000-8000-000000000001", exposureId,
  trackId: "demo:track", feedbackRevision: 5, operation: "revoke", label: null, features, occurredAt: "2026-11-07T12:00:00Z",
};
const observeResponse = { accepted: true, feedbackRevision: 5, modelVersion: version };

function clientFor(response: unknown, status = 200): MlClient {
  return createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => Response.json(response, { status })) });
}

async function failure(promise: Promise<unknown>, expected: { code: string; status: number; retryable: boolean }): Promise<MlClientError> {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(MlClientError);
  expect(caught).toMatchObject(expected);
  expect(String(caught)).not.toContain(secret);
  expect(JSON.stringify(caught)).not.toContain(secret);
  return caught as MlClientError;
}

describe("ML client private transport", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

  test("sends all five authenticated wire contracts to a local service and preserves an optional base path", async () => {
    const received: { method: string; path: string; query: Record<string, string>; auth: string | null; contentType: string | null; body: unknown }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      received.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: request.headers.get("authorization"), contentType: request.headers.get("content-type"), body: request.method === "POST" ? await request.json() : null });
      switch (url.pathname) {
        case "/internal/fit": return Response.json(fitResponse);
        case "/internal/score": return Response.json(scoreResponse);
        case "/internal/observe": return Response.json(observeResponse);
        case "/internal/evaluation": return Response.json(metrics);
        case "/internal/explain": return Response.json({ exposureId, prediction });
        default: return new Response(null, { status: 404 });
      }
    } });
    servers.push(server);
    const client = createMlClient({ serviceUrl: `http://127.0.0.1:${server.port}/internal///`, sharedSecret: secret });
    expect(await client.fit(fitRequest)).toEqual(fitResponse);
    expect(await client.score(scoreRequest)).toEqual(scoreResponse);
    expect(await client.observe(observeRequest)).toEqual(observeResponse);
    expect(await client.evaluation({ userId: "demo:user", modelVersion: version })).toEqual(metrics);
    expect(await client.explain({ userId: "demo:user", exposureId })).toEqual({ exposureId, prediction });
    expect(received.map(row => [row.method, row.path])).toEqual([["POST", "/internal/fit"], ["POST", "/internal/score"], ["POST", "/internal/observe"], ["GET", "/internal/evaluation"], ["GET", "/internal/explain"]]);
    expect(received.every(row => row.auth === `Bearer ${secret}`)).toBe(true);
    expect(received[0]?.body).toEqual(fitRequest);
    expect(received[1]?.body).toEqual(scoreRequest);
    expect(received[2]?.body).toEqual(observeRequest);
    expect(received.slice(0, 3).every(row => row.contentType === "application/json")).toBe(true);
    expect(received[3]?.query).toEqual({ userId: "demo:user", modelVersion: version });
    expect(received[4]?.query).toEqual({ userId: "demo:user", exposureId });
  });

  test("encodes pinned model versions and omits an absent version from query strings", async () => {
    const urls: URL[] = [];
    const encodedVersion = "model /+?&=#";
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async input => {
      const url = new URL(String(input)); urls.push(url);
      return Response.json({ ...metrics, modelVersion: url.searchParams.get("modelVersion") ?? version });
    }) });
    await client.evaluation({ userId: "demo:user", modelVersion: encodedVersion });
    await client.evaluation({ userId: "demo:user" });
    expect(urls[0]?.searchParams.get("modelVersion")).toBe(encodedVersion);
    expect(urls[0]?.hash).toBe("");
    expect(urls[1]?.searchParams.has("modelVersion")).toBe(false);
  });

  test("never follows a redirect carrying the service credential", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { destinationCalls++; return Response.json(scoreResponse); } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`http://127.0.0.1:${destination.port}/score`, 307); } });
    servers.push(origin, destination);
    const client = createMlClient({ serviceUrl: `http://127.0.0.1:${origin.port}`, sharedSecret: secret });
    await failure(client.score(scoreRequest), { code: "ML_UNAVAILABLE", status: 503, retryable: true });
    expect(destinationCalls).toBe(0);
  });

  test("bounds a fetch that never settles and aborts without retrying", async () => {
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, timeoutMs: 15, fetch: ((_input, init) => {
      calls++; signal = init?.signal;
      expect(init?.redirect).toBe("error");
      return new Promise<Response>(() => {});
    }) });
    await failure(client.score(scoreRequest), { code: "ML_TIMEOUT", status: 504, retryable: true });
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
  });

  test("includes response body reading in the timeout", async () => {
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, timeoutMs: 15, fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"userId":')); } }))) });
    await failure(client.score(scoreRequest), { code: "ML_TIMEOUT", status: 504, retryable: true });
  });

  test("sanitizes thrown network errors", async () => {
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => { throw new Error(`network includes ${secret}`); }) });
    const error = await failure(client.score(scoreRequest), { code: "ML_UNAVAILABLE", status: 503, retryable: true });
    expect(error.cause).toBeUndefined();
  });
});

describe("ML client configuration", () => {
  test.each(["", "not a URL", "ftp://ml.example.test", "http://ml.example.test", "https://username:password@ml.example.test", "https://ml.example.test?token=value", "https://ml.example.test#fragment", " https://ml.example.test", "https://ml.example.test\n"])("rejects unsafe URL %j before any request", serviceUrl => {
    expect(() => createMlClient({ serviceUrl, sharedSecret: secret })).toThrow(MlClientError);
  });
  test.each(["", " ", "bad secret", " secret", "secret ", "secret\r\ninjected", "secret\tvalue"])("rejects invalid credentials %j", sharedSecret => {
    expect(() => createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret })).toThrow(MlClientError);
  });
  test.each([0, -1, NaN, Infinity, 0.5, 2 ** 31])("rejects invalid timeout %j", timeoutMs => {
    expect(() => createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, timeoutMs })).toThrow(MlClientError);
  });
  test.each(["http://localhost:8000", "http://127.0.0.1:8000", "http://127.0.0.2:8000", "http://[::1]:8000", "https://ml.example.test:8443"])("supports local HTTP or remote TLS %s", serviceUrl => {
    expect(() => createMlClient({ serviceUrl, sharedSecret: secret })).not.toThrow();
  });
});

describe("ML client schema and identity boundaries", () => {
  test.each([
    ["fit", { ...fitRequest, featureVersion: "unsupported" }],
    ["score", { ...scoreRequest, candidates: [{ trackId: "demo:track", features: { ...features, values: { energy: Infinity } } }] }],
    ["observe", { ...observeRequest, label: 1 }],
    ["evaluation", { userId: "demo:user", unexpected: true }],
    ["explain", { userId: "demo:user", exposureId: "not-a-uuid" }],
  ] as const)("validates %s requests before sending", async (method, input) => {
    let sent = false;
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => { sent = true; return Response.json({}); }) });
    const call = client[method] as (input: unknown) => Promise<unknown>;
    await failure(call(input), { code: "ML_INVALID_REQUEST", status: 400, retryable: false });
    expect(sent).toBe(false);
  });

  test.each(["not JSON", "null", "{}", JSON.stringify({ ...scoreResponse, unexpected: secret }), JSON.stringify({ ...scoreResponse, featureVersion: "unsupported" })])("rejects malformed success payload %j", async body => {
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => new Response(body)) });
    await failure(client.score(scoreRequest), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test.each([
    { ...scoreResponse, userId: "demo:someone-else" },
    { ...scoreResponse, modelVersion: "wrong" },
    { ...scoreResponse, predictions: [] },
    { ...scoreResponse, predictions: [{ trackId: "demo:other", prediction }] },
    { ...scoreResponse, predictions: [{ trackId: "demo:track", prediction: { ...prediction, modelVersion: "wrong" } }] },
    { ...scoreResponse, predictions: [...scoreResponse.predictions, ...scoreResponse.predictions] },
  ])("rejects score response identity mismatch %#", async response => {
    await failure(clientFor(response).score({ ...scoreRequest, modelVersion: version }), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test("matches prediction track multiplicities rather than just sets", async () => {
    const candidates = [...scoreRequest.candidates, ...scoreRequest.candidates, { trackId: "demo:other", features }];
    const predictions = [{ trackId: "demo:other", prediction }, { trackId: "demo:track", prediction }, { trackId: "demo:track", prediction }];
    expect((await clientFor({ ...scoreResponse, predictions }).score({ ...scoreRequest, candidates })).predictions).toEqual(predictions);
    await failure(clientFor({ ...scoreResponse, predictions: [{ trackId: "demo:other", prediction }, { trackId: "demo:other", prediction }, { trackId: "demo:track", prediction }] }).score({ ...scoreRequest, candidates }), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test.each([
    { ...fitResponse, userId: "demo:someone-else" },
    { ...fitResponse, feedbackRevision: 3 },
    { ...fitResponse, modelVersion: "wrong" },
    { ...fitResponse, trainedExamples: 1 },
    { ...fitResponse, metrics: { ...metrics, labeledExamples: 5 } },
    { ...fitResponse, metrics: { ...metrics, heldOutExamples: 1, heldOutPositive: 1, heldOutNegative: 0 } },
    { ...fitResponse, metrics: { ...metrics, heldOutPositive: 2, heldOutNegative: 0 } },
    { ...fitResponse, trainedExamples: 3, metrics: { ...metrics, trainedExamples: 3, evaluationMethod: "none" } },
  ])("rejects fit response revision/count/model mismatch %#", async response => {
    await failure(clientFor(response).fit(fitRequest), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test("does not count holdout or restricted train examples as usable training labels", async () => {
    const examples = fitRequest.examples.map(example => ({ ...example, features: { ...features, permittedForTraining: false } }));
    await failure(clientFor(fitResponse).fit({ ...fitRequest, examples }), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test("rejects observe revision drift", async () => {
    await failure(clientFor({ ...observeResponse, feedbackRevision: 6 }).observe(observeRequest), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test("validates pinned evaluation model versions", async () => {
    await failure(clientFor(metrics).evaluation({ userId: "demo:user", modelVersion: "other" }), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test("validates exact explain exposure identity", async () => {
    await failure(clientFor({ exposureId: "10000000-0000-4000-8000-000000000002", prediction }).explain({ userId: "demo:user", exposureId }), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });

  test.each(["fit", "observe", "evaluation", "explain"] as const)("validates %s response schema", async method => {
    const requests = { fit: fitRequest, observe: observeRequest, evaluation: { userId: "demo:user" }, explain: { userId: "demo:user", exposureId } };
    const call = clientFor({})[method] as (input: unknown) => Promise<unknown>;
    await failure(call(requests[method]), { code: "ML_INVALID_RESPONSE", status: 502, retryable: false });
  });
});

describe("ML client error contract", () => {
  test.each([
    [401, "UNAUTHORIZED", true, false], [409, "STALE_REVISION", true, false], [409, "EXPOSURE_CONFLICT", false, false],
    [404, "MODEL_NOT_FOUND", false, false], [422, "TRAINING_NOT_PERMITTED", false, false],
    [503, "STORAGE_UNAVAILABLE", true, true], [503, "ARTIFACT_UNAVAILABLE", false, false],
    [429, "untrusted-code", true, true], [500, secret, true, true],
  ] as const)("keeps allowlisted code for HTTP %i (%s) and bounds retries", async (status, upstreamCode, requestedRetry, retryable) => {
    let calls = 0;
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => { calls++; return Response.json({ code: upstreamCode, message: `do not leak ${secret}`, retryable: requestedRetry }, { status }); }) });
    const code = upstreamCode === "untrusted-code" || upstreamCode === secret ? "ML_HTTP_ERROR" : upstreamCode;
    const error = await failure(client.score(scoreRequest), { code, status, retryable });
    expect(error.message).not.toContain("do not leak");
    expect(calls).toBe(1);
  });

  test.each([302, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504])("handles non-JSON HTTP %i safely", async status => {
    const client = createMlClient({ serviceUrl: "https://ml.example.test", sharedSecret: secret, fetch: (async () => new Response(`upstream ${secret}`, { status })) });
    await failure(client.score(scoreRequest), { code: "ML_HTTP_ERROR", status, retryable: status === 429 || status >= 500 });
  });

  test("does not accept an invalid error envelope's code or retry hint", async () => {
    await failure(clientFor({ code: "STALE_REVISION", message: secret, retryable: "yes" }, 503).score(scoreRequest), { code: "ML_HTTP_ERROR", status: 503, retryable: true });
  });
});
