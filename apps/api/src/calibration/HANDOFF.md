# Preference-only calibration API

Implements the frozen `981de79` contracts in a separate namespace. Root owns runtime activation and D owns persistence/migrations. No provider client, credentials, write scopes, cleanup service, mutation journal, or C2 dependency is injected into this module.

## Runtime composition

Apply D's calibration migration before enabling these routes. Instantiate `PostgresCalibrationStore(db)` from `@sortfm/db`; it implements the shared `CalibrationStore` without changing `Repository`. Register this module before foundation fallback handlers:

```ts
import {PostgresCalibrationStore} from '@sortfm/db';
import {CalibrationQueue, CalibrationService, createCalibrationModule} from './calibration';
import {assembleLibraryCandidates} from './ml/features';

const calibrationStore = new PostgresCalibrationStore(db);
const calibration = createCalibrationModule({
  config: {secureCookies: config.apiOrigin.startsWith('https:'),
    webOrigin: config.webOrigin, apiOrigin: config.apiOrigin},
  auth: spotify.auth,
  service: new CalibrationService(calibrationStore, {feedback: feedbackWorker}),
  queue: new CalibrationQueue(calibrationStore, {
    score: ml ? (userId, candidates) => ml.score(userId, candidates) : undefined,
    assemble: (library, {userId, now}) => assembleLibraryCandidates(library, {
      userId, now: new Date(now).toISOString(),
      metadataTraining, // The existing explicitly configured permission/rights basis.
    }),
  }),
});
await calibration.registerRoutes(app);
```

Use the same `RepositoryMl` and durable `FeedbackWorker` as cleanup/manual retraining. Do not add `/observe`. The service kicks delivery only after the transaction returns a verified result; polling recovers a missed kick. No additional lifecycle worker is created. The default feature assembler deliberately grants no training permission: inject the existing configured permission policy to enable authorized training. Missing audio remains missing.

## Public behavior

- `GET /api/calibration/queue?limit=20`: owner-only, limit 1–100. Full current library supplies features; only D-eligible saved/deferred playable Spotify tracks can be selected. Round-robin save-age quartiles prefer diverse primary artists with a deterministic owner/track hash tie-breaker. Selection never uses scores, labels, evaluation results or splits. This online sampling is separate from C1's sealed offline experiment.
- `POST /api/calibration/labels`: strict shared request with `label: 0 | 1`. Transaction commits synchronously before HTTP 200. Persist the original idempotency key until the authoritative result is recovered. “Skip” is a local UI action and creates no server label.
- `POST /api/calibration/labels/:id/undo`: strict shared Undo request. Revokes training feedback only. It does not restore Spotify state, remove an archive copy, or revive older feedback.
- `GET /api/calibration/history`: restores active/revoked/superseded states and original label keys for response-loss recovery. `submittedLabel` preserves the original preference independently of the current effective `label`.

All routes require the existing owner session, reject foreign Origin, and send no-store headers. POST also requires allowed Origin and rejects cross-site requests. The browser cannot supply owner, split, revision, purpose, features, model or cleanup action. Session credentials and internal exception text never enter result bodies or logs.

Predictions come from one keyed C1 request for the selected page. A missing, invalid or late score uses an explicit untrained/null baseline and fresh exposure IDs, preserving explanation identity if a late ML request completes. Each exposure is durably inserted with calibration purpose before any page returns. Concurrent eligibility changes may fail the page; refresh instead of using undelivered IDs. Partial inserts are immutable unconsumed exposures and never create labels. The default ML deadline is 2 seconds; it does not bound database queries.

D resolves same-key retries before current eligibility checks. A never preflights label/Undo reads. Known conflicts return sanitized 409, missing identities 404, invalid requests 400, invalid dependency results 502, and unavailable dependencies 503. Current authoritative replay state can be revoked or superseded. Neither a repeated delivery kick nor a replay advances the owner revision.

## Verification commands

```sh
bun test apps/api/src/calibration
bun run typecheck
bun run build
# Provide a private TEST_DATABASE_URL through the environment, never a committed file.
CALIBRATION_INTEGRATION=1 bun test apps/api/src/calibration/integration.test.ts
```

The opt-in integration test requires D's exported adapter, Tiger/Postgres access and `uv`. It creates and drops a uniquely named schema, seeds generated tracks through normal import membership publication, and starts an isolated real C1 process using a temporary artifact directory. It never uses the serving model or contacts Spotify. Generated binary labels exercise transport/training; they are not human preferences or a model efficacy claim.

Unit coverage includes strict authentication/CSRF, canonical fingerprints, response loss/replay after Undo, persistence/result failures, unavailable kick recovery, diverse sampling independent of score, complete-library feature context, null audio, scoring mismatch/deadline fallback, stale eligibility, and a 2,768-track fixture. Persistence atomicity, fixed splits, cleanup precedence and wrong-purpose checks are D-owned and additionally exercised where applicable by the opt-in acceptance.

Runtime activation, real browser acceptance and deployment remain root/B responsibilities. No live Spotify mutations or production migration are part of this handoff.

## Implementation commit verification

The API commit passes 544 Bun tests (68 environment-gated skips), 2,928 assertions, root TypeScript checking, web/API build, standalone calibration bundling and diff checks. Independent read-only review found no remaining actionable runtime defect. Build output retains the existing Zod annotation warnings. Changes outside this directory are limited to adding `EXPOSURE_PURPOSE_MISMATCH` to the existing review-route 409 mapping, with a focused regression here.

The opt-in acceptance test described above is prepared as a separate follow-up pending D's committed adapter. It is not included or claimed passing in the standalone API commit. Until that integration runs, database/C1 calibration acceptance remains unverified and live activation must wait.
