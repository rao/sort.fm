# Explicit snapshot retraining

`createMlRetrainModule` separately registers the frozen `POST /api/ml/retrain` route. The insights/analytics registrar remains read-only. Root installs this registrar before foundation stubs and injects the same `RepositoryMl` instance/configuration used by automatic feedback:

```ts
import {createMlRetrainModule} from './ml';

const retrain = createMlRetrainModule({
  config: {...config, secureCookies: config.apiOrigin.startsWith('https:')},
  auth: spotify.auth,
  ml, // Existing repository-backed adapter, or null if unavailable
  timeoutMs: 45_000, // Optional total handler wait budget
});
await retrain.registerRoutes(app);
```

The route requires a valid owner session and an allowed Origin, and rejects cross-site requests using the existing review CSRF/security helper. Query parameters must be empty. The body must be absent or `{}`; null, arrays, strings, labels, user identity, model version, revision and all other supplied fields are rejected. The browser never supplies training data. Identity comes only from the authenticated session.

The route calls `RepositoryMl.fit(userId)` exactly once. That adapter reads D's transactionally consistent revision and complete effective-label snapshot, preserving exposure-time features and fixed train/holdout assignments. It does not reconstruct features from today's audio enrichment. The HTTP client validates the returned revision and counts against that actual snapshot. The registrar additionally validates FitResponse, session owner, model/metrics version agreement, and trained-count agreement before returning success. Invalid dependency responses return a sanitized 502 rather than a client validation error or fabricated success.

Repeated unchanged snapshots may return the **same model version**. C1 serializes per-user writes and accepts identical same-revision full-fit requests idempotently. Therefore automatic feedback and explicit retraining can fit the same snapshot concurrently. D supplies deterministic ordering; use the same evaluation seed and adapter configuration as the automatic worker. A snapshot overtaken by a newer revision returns a sanitized `409 STALE_REVISION`; the registrar does not replace that error with current evaluation data or retry it automatically.

A higher-revision empty snapshot after all labels are undone is valid and removes prior active labels. C1 returns actual zero counts, insufficient-data metrics and its existing empty-set dataset classification. The route preserves that response, including `dataset: synthetic` for the empty-set contract fallback; it does not invent user-feedback provenance or numerical evaluation values.

## Timeouts and failures

The total handler wait budget includes session lookup and fit. A session lookup timeout returns `503 AUTHENTICATION_UNAVAILABLE`; no fit starts after that abandoned lookup. Once fitting starts, either the handler deadline or an inner ML HTTP timeout returns `504 ML_RETRAIN_TIMEOUT` with an explicit warning that training may still complete. Transport failures return a sanitized 503 with the same ambiguous-outcome guidance. Internal ML credential failures are service failures, not public session-authentication failures.

After an ambiguous fit failure, refresh model insights before explicitly requesting another fit. The registrar never retries POST operations; ambiguity errors use `retryable: false` to discourage automatic write retries. The frontend already requires a model refresh before another explicit request. A timeout does not cancel a submitted fit or guarantee rollback. Late resolution/rejection is contained and cannot change the already returned response.

The outer 45-second default does not extend the existing ML HTTP client's default 10-second deadline, database deadlines, or browser timeout. Configure those limits in the composition root if needed; this module does not change them. Null ML configuration returns an explicit 503 without inventing a model result.

The registrar never acknowledges feedback-outbox leases, adds `/observe`, changes Spotify, or records model runs with guessed metadata. The automatic worker retains ownership of its delivery/acknowledgement flow and can safely replay the same completed full snapshot. No Python, C2, shared schema, database or runtime files are changed by this module.

## Verification

```sh
bun test apps/api/src/ml/retrain.test.ts
ML_ADAPTER_INTEGRATION=1 bun test apps/api/src/ml/integration.test.ts
bun run typecheck
bun run test
bun run build
uv run --directory services/ml pytest -q
```

The opt-in integration test starts an isolated real C1 FastAPI service with temporary synthetic data. It exercises concurrent manual/automatic fits, exact repeated responses, higher-revision empty snapshots representing completed Undo, and stale-snapshot rejection without restoring deleted labels. It does not perform a live database Undo or contact Spotify/SoundNet. Root owns runtime registration and its real database/workflow smoke checks.

Verified on 2026-11-07 from base `648ef84`: 56 focused tests passed (380 assertions), including cookie/owner/origin/CSRF checks, strict bodies, response mismatch, total deadlines, late completion/rejection and no retries. Full TypeScript suite with `ML_ADAPTER_INTEGRATION=1`: 435 passed, 66 environment-gated tests skipped, 0 failed (2303 assertions). All 228 Python tests passed unchanged. Typecheck, root web/API build, standalone ML-module bundle and diff checks passed; the web build retains two existing Zod comment-annotation warnings. Independent read-only review found no actionable findings and reran the 56 focused tests successfully.
