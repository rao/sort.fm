import assert from "node:assert/strict";
import { ErrorEnvelopeSchema, INTERNAL_ROUTES } from "../packages/contracts/src/index";

// Reserve an available loopback port briefly; the child uses no provider credentials.
const probe = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")});
const port = probe.port!;
await probe.stop(true);
const secret = crypto.randomUUID();
const child = Bun.spawn(["uv", "run", "--locked", "--directory", "services/ml", "uvicorn", "sortfm_ml.app:app", "--host", "127.0.0.1", "--port", String(port)], {env: {...process.env, ML_SERVICE_SHARED_SECRET: secret}, stdout: "ignore", stderr: "pipe"});
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`ML service exited before startup (${child.exitCode})`);
    const response = await fetch(`${base}/health`).catch(() => null);
    if (response?.ok) { INTERNAL_ROUTES.health.response.parse(await response.json()); ready = true; break; }
    await Bun.sleep(100);
  }
  assert(ready, "ML health must become ready within 10 seconds");
  for (const route of Object.values(INTERNAL_ROUTES).filter(route => route.auth === "shared_secret")) {
    for (const [token, status, code] of [["", 401, "UNAUTHORIZED"], ["wrong", 401, "UNAUTHORIZED"], [secret, 501, "NOT_IMPLEMENTED"]] as const) {
      const response = await fetch(`${base}${route.path}`, {method: route.method, headers: token ? {Authorization: `Bearer ${token}`} : {}});
      assert.equal(response.status, status);
      assert.equal(ErrorEnvelopeSchema.parse(await response.json()).code, code);
    }
  }
  console.log("PASS ML HTTP smoke: /health contract, all five internal endpoints deny absent/wrong tokens and report authenticated capabilities as unimplemented. No fabricated model outputs.");
} finally { child.kill("SIGTERM"); await child.exited; }
