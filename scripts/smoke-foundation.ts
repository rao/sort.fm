import assert from "node:assert/strict";
import { buildApp } from "../apps/api/src/app";
import { loadConfig } from "../apps/api/src/config";
import { createApiClient, createIdempotencyKey, ApiError } from "../packages/contracts/src/client";
import { ErrorEnvelopeSchema } from "../packages/contracts/src/index";

const app = await buildApp({config: loadConfig({NODE_ENV: "test", DEMO_MODE_ENABLED: "true"})});
try {
  const baseUrl = await app.listen({host: "127.0.0.1", port: 0});
  const client = createApiClient({baseUrl});
  assert.equal((await client.health()).capabilities.spotify, false);
  assert.equal((await client.session()).mode, "anonymous");
  const bootstrap = await client.demoBootstrap();
  assert.equal(bootstrap.session.mode, "demo");
  assert.equal(bootstrap.metrics.rocAuc, null);
  const queue = await client.queue({mode: "demo", limit: 2});
  assert.equal(queue.items.length, 2);
  assert(queue.items.every(item => item.track.source === "synthetic" && item.track.spotifyUri === null));
  const first = queue.items[0]!;
  await assert.rejects(() => client.decide({trackId: first.track.trackId, action: "ARCHIVE", exposureId: first.exposure.exposureId, idempotencyKey: createIdempotencyKey()}), (error: unknown) => error instanceof ApiError && error.status === 501 && error.error.code === "NOT_IMPLEMENTED");
  const invalid = await fetch(`${baseUrl}/api/queue?mode=demo&limit=-1`);
  assert.equal(invalid.status, 400);
  assert.equal(ErrorEnvelopeSchema.parse(await invalid.json()).code, "VALIDATION_ERROR");
  const forbidden = await fetch(`${baseUrl}/api/health`, {headers: {Origin: "https://untrusted.example"}});
  assert.equal(forbidden.status, 403);
  const preflight = await fetch(`${baseUrl}/api/decisions`, {method: "OPTIONS", headers: {Origin: "http://127.0.0.1:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
  console.log("PASS foundation HTTP smoke: health, anonymous session, synthetic bootstrap/queue, honest metrics, mutation boundary, validation, origin rejection, credentialed preflight. No Spotify calls.");
} finally { await app.close(); }
