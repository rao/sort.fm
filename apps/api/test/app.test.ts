import { afterEach, expect, test } from "bun:test";
import { createApiClient, ApiError } from "@sortfm/contracts/client";
import { PUBLIC_ROUTES, QueueResultSchema } from "@sortfm/contracts";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function app(demo = true) {
  const instance = await buildApp({config: loadConfig({NODE_ENV: "test", DEMO_MODE_ENABLED: String(demo)})});
  apps.push(instance); return instance;
}
test("health states actual capabilities and no provider credentials", async () => {
  const response = await (await app()).inject({url: "/api/health"});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({status: "ok", service: "api", contractVersion: "1.0.0", capabilities: {demo: true, spotify: false, database: false, ml: false}});
});
test("queue requires explicit demo intent, validates limit and separates exposure requests", async () => {
  const server = await app();
  expect((await server.inject({url: "/api/queue"})).statusCode).toBe(401);
  expect((await server.inject({url: "/api/queue?mode=demo&limit=0"})).statusCode).toBe(400);
  const one = QueueResultSchema.parse((await server.inject({url: "/api/queue?mode=demo&limit=2"})).json());
  const two = QueueResultSchema.parse((await server.inject({url: "/api/queue?mode=demo&limit=2"})).json());
  expect(one.items).toHaveLength(2);
  expect(one.items[0]?.track.source).toBe("synthetic");
  expect(one.items[0]?.prediction.removalProbability).toBeNull();
  expect(one.items[0]?.exposure.exposureId).not.toBe(two.items[0]?.exposure.exposureId);
});
test("disabling demo blocks bootstrap and queue", async () => {
  const server = await app(false);
  expect((await server.inject({url: "/api/demo/bootstrap"})).statusCode).toBe(404);
  expect((await server.inject({url: "/api/queue?mode=demo"})).statusCode).toBe(404);
});
test("unfinished mutations never claim success and forged identity is rejected", async () => {
  const server = await app();
  const payload = {trackId: "demo:001", action: "ARCHIVE", exposureId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID()};
  const valid = await server.inject({method: "POST", url: "/api/decisions", payload});
  expect(valid.statusCode).toBe(501);
  expect(valid.json().code).toBe("NOT_IMPLEMENTED");
  expect((await server.inject({method: "POST", url: "/api/decisions", payload: {...payload, userId: "victim"}})).statusCode).toBe(400);
  expect((await server.inject({method: "POST", url: "/api/decisions/bad-id/undo", payload: {idempotencyKey: crypto.randomUUID()}})).statusCode).toBe(400);
});
test("malformed JSON and unknown paths use the shared envelope", async () => {
  const server = await app();
  const invalid = await server.inject({method: "POST", url: "/api/decisions", headers: {"content-type": "application/json"}, payload: "{"});
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({code: "BAD_REQUEST", message: "Invalid request.", retryable: false});
  expect((await server.inject({url: "/missing"})).json().code).toBe("NOT_FOUND");
});
test("only exact configured origins receive credentialed CORS", async () => {
  const server = await app();
  const allowed = await server.inject({url: "/api/health", headers: {origin: "http://127.0.0.1:5173"}});
  expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  const forbidden = await server.inject({method: "POST", url: "/api/decisions", headers: {origin: "https://evil.example"}, payload: {}});
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.headers["access-control-allow-origin"]).toBeUndefined();
});
test("typed browser client consumes actual routes and propagates API errors", async () => {
  const server = await app();
  const transport = (async (input, init) => {
    const response = await server.inject({method: init?.method as "GET" | "POST", url: String(input), ...(init?.body ? {payload: String(init.body), headers: {"content-type": "application/json"}} : {})});
    return new Response(response.body, {status: response.statusCode, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
  const client = createApiClient({fetch: transport});
  const bootstrap = await client.demoBootstrap();
  expect(bootstrap.session.mode).toBe("demo");
  expect((await client.queue({mode: "demo", limit: 3})).items).toHaveLength(3);
  await expect(client.queue()).rejects.toBeInstanceOf(ApiError);
});
test("all published public routes are registered", async () => {
  const server = await app();
  for (const route of Object.values(PUBLIC_ROUTES)) expect(server.hasRoute({method: route.method, url: route.path})).toBe(true);
});
test("production config enforces TLS and does not accept boolean typos", () => {
  expect(() => loadConfig({NODE_ENV: "production", PUBLIC_WEB_ORIGIN: "http://sort.fm"})).toThrow();
  expect(() => loadConfig({DEMO_MODE_ENABLED: "tru"})).toThrow();
  const config = loadConfig({NODE_ENV: "production"});
  expect(config.webOrigin).toBe("https://sort.fm");
  expect(config.apiOrigin).toBe("https://api.sort.fm");
});

test('installed registrars can replace the live queue and health reports supplied capabilities',async()=>{
 const server=await buildApp({config:loadConfig({NODE_ENV:'test'}),capabilities:{database:true,spotify:true},registerRoutes:app=>{
  app.get(PUBLIC_ROUTES.queue.path,async()=>({installed:true}));
 }});apps.push(server);
 expect((await server.inject({url:'/api/queue'})).json()).toEqual({installed:true});
 expect((await server.inject({url:'/api/health'})).json().capabilities).toEqual({demo:true,spotify:true,database:true,ml:false});
});
