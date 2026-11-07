# Public model and analytics reads

`createMlReadModule` installs the existing authenticated GET routes `/api/ml/insights` and `/api/analytics/summary`. Root runtime installs this registrar before foundation stubs. No shared contract changes, Python/C2 changes, retraining endpoint, provider requests or new dependencies are required.

```ts
import {createMlReadModule} from './ml';

const reads = createMlReadModule({
  config: {...config, secureCookies: config.apiOrigin.startsWith('https:')},
  auth: spotify.auth,
  getSummary: userId => a1Store.transaction(tx => tx.getSummary(userId)),
  audioProgress: userId => soundnetQueue.progress(userId),
  ml, // RepositoryMl or null when the service is not configured
  latestModel: userId => repository.latestModel(userId),
  readTimeoutMs: 2000, // Optional; default 2 seconds per dependency read
});
await reads.registerRoutes(app);
```

Here `a1Store` is the configured `PostgresA1Store`, `soundnetQueue` is D's `SoundNetQueue`, and `repository` is D's `Repository`. These dependencies are injected rather than constructed by the module. `auth` accepts the existing AuthService structural session interface. Existing `reviewRouteSecurity` supplies cookie parsing, session owner resolution, origin rejection, safe error envelopes and no-store headers. These GETs require no mutation CSRF check. Unknown query parameters/body payloads cannot select another user, model, track, exposure or demo mode.

Insights returns current C1 metrics and actual SoundNet progress. Its prediction is always null: the public wire contract does not identify an exposure, and choosing a recent/random track would misrepresent what the user is viewing. Actual card predictions remain on queue items. Analytics returns current C1 metrics and D's library summary exactly; total, reviewed and remaining describe different populations and are not recomputed from one another. Neither route reads training examples, refits, scores candidates or starts enrichment.

If ML is missing, fails validation, fails transport or exceeds the read deadline, the optional latestModel reader can supply a stored model run. The registrar validates the complete record, its owner, model version and trained-count agreement. A fallback response keeps its actual historical counts, version, dataset, evaluation method and evaluation timestamp, sets status to unavailable, clears all seven numerical evaluation values, and explicitly says the counts/version are from the last recorded run and may be stale. Private fields such as artifactPath never leave the server.

Without a valid recorded run, the response is a sanitized retryable **503 ML_UNAVAILABLE**. The contract requires integer counts and a model version, so no zero-filled or fake untrained object is substituted for unknown state. Missing audio/library data similarly returns an explicit 503; no progress/summary counts are invented. Invalid client input is 400; invalid dependency data is 503. The UI can keep its existing unavailable state and retry.

Current integration caveat: D supports `recordModelRun`/`latestModel`, but the existing feedback worker does not record model runs. Until an integration-owned caller records successful fits, an ML outage may have no snapshot to display. Absence of a database run does not establish absence of trained models or feedback. These endpoints do not add writes to repair that gap.

The per-read timeout bounds HTTP-handler waiting, including auth and database ports. It does not cancel an already running dependency promise; the ML HTTP client and database adapters retain their own I/O deadlines. ML failure followed by a stored snapshot read can take two such deadlines, in addition to session lookup. Late results do not mutate responses or become an unhandled rejection. Reads do not retry or initiate training.

## Verification

```sh
bun test apps/api/src/ml/reads.test.ts apps/api/src/ml/reads.auth.test.ts
ML_ADAPTER_INTEGRATION=1 bun test apps/api/src/ml/integration.test.ts
bun run typecheck
bun run test
bun run build
uv run --directory services/ml pytest -q
```

Tests use synthetic dependency records, actual Fastify routing and actual AuthService session resolution. The opt-in test starts a temporary C1 FastAPI service and verifies that both public reads expose its real fitted/evaluated results. It never contacts a live database, Spotify or SoundNet. Root runtime wiring and live-owner verification remain integration responsibilities.

Verified on 2026-11-07 on base `d6d55b4`: 55 focused public-read/auth tests passed. Full suite with `ML_ADAPTER_INTEGRATION=1`: 317 passed, 55 environment-gated database/provider checks skipped, 0 failed. All 228 Python tests passed unchanged. Root typecheck, web/API build, standalone ML-module bundle and diff checks passed. Build retains the two existing Zod comment-annotation warnings. The test suite exposed Fastify's unparsed GET-body behavior; the registrar now rejects body framing as well as parsed payloads.

Independent read-only review found no actionable issues and reran the 55 focused tests successfully. Saved-run persistence is intentionally not added: the current FitResponse does not supply all model-run metadata, so synthesizing that metadata would be incorrect.
