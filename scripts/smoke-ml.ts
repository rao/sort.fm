import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorEnvelopeSchema, FEATURE_VERSION, INTERNAL_ROUTES } from "../packages/contracts/src/index";

// Reserve an available loopback port briefly; the child uses no provider credentials.
const probe = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")});
const port = probe.port!;
await probe.stop(true);
const secret = crypto.randomUUID();
const directory = await mkdtemp(join(tmpdir(), "sortfm-ml-contract-"));
const child = Bun.spawn(["uv", "run", "--locked", "--directory", "services/ml", "uvicorn", "sortfm_ml.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {env: {...process.env, ML_SERVICE_SHARED_SECRET: secret, ML_ARTIFACT_DIR: directory}, stdout: "ignore", stderr: "pipe"});
const base = `http://127.0.0.1:${port}`;
async function json(path: string, body?: unknown, expected = 200) {
  const response = await fetch(`${base}${path}`, {method: body === undefined ? "GET" : "POST",
    headers: {Authorization: `Bearer ${secret}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(30_000)});
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`);
  return result;
}
try {
  let ready = false;
  const startupDeadline = Date.now() + 30_000;
  while (Date.now() < startupDeadline) {
    if (child.exitCode !== null) throw new Error(`ML service exited before startup (${child.exitCode})`);
    const response = await fetch(`${base}/health`, {signal: AbortSignal.timeout(1000)}).catch(() => null);
    if (response?.ok) {
      const health = INTERNAL_ROUTES.health.response.parse(await response.json());
      assert.deepEqual(health.capabilities, {scoring: true, training: true}); ready = true; break;
    }
    await Bun.sleep(100);
  }
  assert(ready, "ML health must become ready within 30 seconds, including locked-environment startup");
  for (const route of Object.values(INTERNAL_ROUTES).filter(route => route.auth === "shared_secret")) {
    for (const [token, status, code] of [["", 401, "UNAUTHORIZED"], ["wrong", 401, "UNAUTHORIZED"]] as const) {
      const response = await fetch(`${base}${route.path}`, {method: route.method, headers: token ? {Authorization: `Bearer ${token}`} : {}, signal: AbortSignal.timeout(30_000)});
      assert.equal(response.status, status);
      assert.equal(ErrorEnvelopeSchema.parse(await response.json()).code, code);
    }
  }
  ErrorEnvelopeSchema.parse(await json("/fit", {}, 422));
  // These authored labels test service mechanics, not effectiveness on real listeners.
  const userId = "synthetic:integration-smoke";
  const fitRequest = INTERNAL_ROUTES.fit.body.parse({userId, featureVersion: FEATURE_VERSION, feedbackRevision: 80, evaluationSeed: 42,
    examples: Array.from({length: 80}, (_, i) => ({trackId: `synthetic:track-${i}`, decisionId: crypto.randomUUID(), label: i % 2,
      split: i < 60 ? "train" : "holdout", labeledAt: "2026-11-07T12:00:00Z",
      features: {featureVersion: FEATURE_VERSION, provenance: "synthetic", permittedForTraining: true,
        rightsBasis: "Programmatically authored integration fixture; no real listener claims",
        values: {energy: i % 2 ? 0.7 : 0.3, saved_age_days: i * 3, duration_ms: 180_000 + i * 100}}})),
  });
  const example = fitRequest.examples[0]!;
  const candidate = {trackId: example.trackId, features: example.features};
  const cold = INTERNAL_ROUTES.score.response.parse(await json("/score", INTERNAL_ROUTES.score.body.parse({userId, featureVersion: FEATURE_VERSION, candidates: [candidate], modelVersion: null})));
  assert.equal(cold.predictions[0]!.prediction.removalProbability, null);
  assert.equal(INTERNAL_ROUTES.evaluation.response.parse(await json(`/evaluation?userId=${userId}`)).status, "insufficient_data");
  const fitted = INTERNAL_ROUTES.fit.response.parse(await json("/fit", fitRequest));
  assert.equal(fitted.trainedExamples, 60);
  assert.equal(fitted.metrics.status, "available");
  assert.deepEqual(INTERNAL_ROUTES.fit.response.parse(await json("/fit", fitRequest)), fitted);
  assert.deepEqual(INTERNAL_ROUTES.evaluation.response.parse(await json(`/evaluation?userId=${userId}`)), fitted.metrics);
  const exposureId = crypto.randomUUID();
  const scoring = INTERNAL_ROUTES.score.body.parse({userId, featureVersion: FEATURE_VERSION, candidates: [{...candidate, exposureId}], modelVersion: null});
  const original = INTERNAL_ROUTES.score.response.parse(await json("/score", scoring));
  assert.equal(original.modelVersion, fitted.modelVersion);
  assert.equal(original.predictions[0]!.prediction.modelKind, "logistic");
  assert.notEqual(original.predictions[0]!.prediction.removalProbability, null);
  const undo = INTERNAL_ROUTES.observe.body.parse({userId, eventId: crypto.randomUUID(), decisionId: example.decisionId,
    exposureId, trackId: example.trackId, feedbackRevision: 81, operation: "revoke", label: null,
    features: example.features, occurredAt: "2026-11-07T12:01:00Z"});
  const observed = INTERNAL_ROUTES.observe.response.parse(await json("/observe", undo));
  assert(observed.accepted);
  assert.equal(observed.feedbackRevision, 81);
  assert.notEqual(observed.modelVersion, fitted.modelVersion);
  assert.deepEqual(INTERNAL_ROUTES.observe.response.parse(await json("/observe", undo)), observed);
  assert.equal(INTERNAL_ROUTES.evaluation.response.parse(await json(`/evaluation?userId=${userId}`)).trainedExamples, 59);
  assert.deepEqual(INTERNAL_ROUTES.score.response.parse(await json("/score", scoring)), original);
  const conflict = {...scoring, candidates: [{...candidate, exposureId, features: {...candidate.features, values: {energy: 0.99}}}]};
  assert.equal(ErrorEnvelopeSchema.parse(await json("/score", conflict, 409)).code, "EXPOSURE_CONFLICT");
  const explanation = INTERNAL_ROUTES.explain.response.parse(await json(`/explain?userId=${userId}&exposureId=${exposureId}`));
  assert.deepEqual(explanation.prediction, original.predictions[0]!.prediction);
  assert.equal(ErrorEnvelopeSchema.parse(await json(`/explain?userId=synthetic:other&exposureId=${exposureId}`, undefined, 404)).code, "EXPOSURE_NOT_FOUND");
  console.log("PASS ML integration HTTP smoke: all private routes enforce auth; shared Zod contracts validate cold start, fit, computed synthetic metrics, scoring, Undo, retry, conflict, user isolation and immutable explanation. No provider calls or real-listener effectiveness claim.");
} finally { child.kill("SIGTERM"); await child.exited; await rm(directory, {recursive: true, force: true}); }
