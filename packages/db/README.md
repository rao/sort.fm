# sort.fm persistence and SoundNet operations

Requires Bun and PostgreSQL. No additional JS dependency or queue service. Database code uses Bun SQL parameterized queries, disables prepared statements for PgBouncer, and scopes every operation to the configured schema (default `sortfm`). `DATABASE_URL` stays server-side; preserve its TLS settings. Do not disable certificate verification. A direct connection URL can be supplied for migrations if the pooler's DDL permissions differ.

## Configure and migrate

From this worktree:

```sh
cd /Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-d
bun install --frozen-lockfile
bun --env-file=../sort.fm/.env packages/db/src/migrate.ts
```

After integration, run from the canonical repository with `--env-file=.env`. Deploy all files under `packages/db/migrations` alongside the migration source. Migrations use one transaction and advisory lock; checksums prevent silently editing applied SQL. Repeating the command is safe. Optional Timescale conversion uses the installed extension; ordinary PostgreSQL remains fully supported. The runner reports `hypertable: true|false`. No extension installation or destructive rollback runs automatically.

Settings:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URL, including TLS settings |
| `DATABASE_SCHEMA` | Optional isolated schema, default `sortfm` |
| `SOUNDNET_RAPIDAPI_KEY` | Server-only RapidAPI key |
| `SOUNDNET_CONCURRENCY` | Initial in-flight cap, default 3 |
| `SOUNDNET_MAX_CONCURRENCY` | Adaptive upper cap, default 5, maximum 200 |
| `SOUNDNET_RIGHTS_BASIS` | Reviewed source-use basis; absent means `permittedForTraining=false` |
| `TEST_DATABASE_URL` | Opt-in integration-test database; tests create/drop only their random `test_*` schemas |
| `RUN_SLOW_SOUNDNET_TEST` | Enable the separate 35-second mocked HTTP test |

A1 handles encryption with `TOKEN_ENCRYPTION_KEY`. Its adapter requires already encrypted `v1` token/PKCE envelopes; it never accepts plaintext or implements OAuth. Tokens are absent from public DTOs and logs. Keep the key in deployment secrets and backed up separately from database backups.

## Start and resume audio ingestion

First finish an actual Spotify library import through A1. Replace `USER_ID` with its server-side user ID. The CLI does not implement Spotify login/import or mutations.

```sh
# Quick DB-only queue insertion; no provider requests or blocking API work.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts enqueue --user USER_ID

# Five distinct artists from this imported library. Raw successful responses are cached.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts smoke --user USER_ID

# Review printed matching information and cached raw responses, latency, quality and errors.
# Run this only after accepting all five successful samples; never approve mismatched tracks.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts approve-smoke

# Start OR resume: exactly the same command. Run as a separate worker process.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts run

# Poll without contacting SoundNet.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts status --user USER_ID

# Explicitly requeue exhausted/permanent failures after fixing their cause.
# This resets attempt counts and may consume additional paid requests.
bun --env-file=../sort.fm/.env apps/api/src/jobs/soundnet/cli.ts retry-failed
```

`run` processes queued tracks globally, deduplicated by `(trackId,featureVersion)`. Smoke approval expires after seven days. Repeating enqueue/smoke skips committed successful caches; rerunning smoke itself does not authorize the backfill. The worker drains due and future retries, then exits once no unfinished jobs remain. SIGINT/SIGTERM stops claiming and aborts in-flight requests; interrupted leases recover within three minutes. A process supervisor may restart `run` after a DB outage. All instances sharing a RapidAPI subscription **must share the same database/schema**; uncoordinated external clients using the same key are outside this limiter.

Rate control is a durable one-token bucket with no burst credit, conservative 250ms reservation windows. A committed permit is validated under a row lock before the actual request starts, retaining pacing even if that transaction fails. At most five starts occur in any rolling second. Provider responses are awaited after releasing the DB transaction. Defaults start at three concurrent requests; 20 successes permit a one-slot ramp, while transient failures reduce concurrency and 429 halves it. A persisted global cooldown honors numeric/date `Retry-After` headers; retries use capped exponential backoff with jitter. Five attempts per track, 90-second timeout, 1 MiB response cap. Authentication failures stop the worker with an hour cooldown to avoid burning requests across the queue.

Leases renew every 30 seconds and fence stale writers. Completion stores the feature cache and success atomically. Raw valid JSON that cannot normalize is retained in `soundnet_failures`; non-2xx provider bodies and headers are not logged. Successful smoke writes are reconciled with expired worker leases. **Committed successes are not fetched again.** A crash after a provider response but before cache commit may require another billable request; exactly-once provider charging cannot be guaranteed without provider idempotency support. Provider failures never block metadata-only library reads or the API request path.

Normalization accepts the documented flat fields, converts 0–100 scores (including popularity) to [0,1], parses `mm:ss` and `-5 dB`, encodes named pitch classes cyclically, and retains nulls and field-level missingness. Unknown units/invalid ranges are null, not invented values. `happiness` stays distinct from Spotify valence. Error bodies, all-missing responses and explicit track-ID mismatches fail validation. Raw JSON is private diagnostic data. The real provider schema/matching remains subject to the smoke gate.

## API and Python integration

```ts
import {connectDatabase, PostgresA1Store, Repository, SoundNetQueue} from '@sortfm/db';
const db = connectDatabase();
const authStore = new PostgresA1Store(db); // Inject into A1 services/registrar.
const repository = new Repository(db);
const queue = new SoundNetQueue(db);
```

- `PostgresA1Store` implements shared `A1Store`. All callbacks run atomically at SERIALIZABLE isolation, return detached values, and roll back on throw. Only definite 40001/40P01 rollbacks retry, at most three times; callbacks must contain no external effects or network I/O. A1 owns credential/refresh fencing inside those transactions. `completeImportMembership` publishes only a completed pass. Observations deduplicate on `(userId,jobId,pass,offset)`; history survives resync/empty libraries. Partial imports never publish removals.
- `upsertSavedTracks` batches validated inputs in two SQL statements and preserves original timestamps/status. `library(userId)` returns current confirmed membership, or partial snapshots before the first complete sync. Each item includes `track`, `currentStatus`, nullable `audioFeatures`, and nullable `currentDecision` (including pending workflows). `library(userId,true)` explicitly reads all historical snapshots. API queue owners must filter review status and playability and avoid currently pending decisions.
- `insertExposure`/`getExposure` retain immutable predictions and feature vectors. `createDecision` persists/deduplicates the command before side effects. Reused keys with different payloads conflict. `createUndo` reserves a settled current decision and blocks competing commands while restoration runs. `transitionMutation` is a CAS journal for the caller's remote workflow; `setArchivePlaylist` and archive records persist successful insertion facts.
- `settleDecision(userId,result,expectedStatus,split)` validates the result and atomically changes decision state, current membership/count, feedback revision, and genuine swipe telemetry. A2 must confirm remote state first, supply the correct next revision, and persist undo before restoration. The repository never performs or guesses a Spotify mutation. Pending/failed replacement reviews preserve effective training feedback. SKIP replacing an active label writes a revised null tombstone. Fixed split membership survives subsequent reviews/undo. Pending undo commands remain reserved until reconciliation completes; do not start a fresh review to bypass an ambiguous restore.
- `trainingExamples(userId)` returns a revision-consistent `{feedbackRevision, examples}` snapshot, including immutable feature-at-exposure vectors and stable train/holdout splits. Pass these to Python using the frozen `/fit` contract; for `/score`, combine library metadata with nullable audio using C's feature assembly. A2 owns ML transport; the durable revision queue below schedules full `/fit` reconciliation atomically with feedback. No model training occurs here. SQL view `sortfm.ml_training_examples` supports a separately provisioned restricted read role; all queries must filter authenticated `user_id`.
- `recordModelRun` and `latestModel` preserve immutable versions and validated evaluation metrics. `recordTelemetry` deduplicates event IDs outside the hypertable, then writes both event and time-series row atomically. `analytics(userId,from,to)` returns minute buckets by event type/model, observed score/uncertainty/latency means and action counts. No fabricated model metrics. `queue.progress(userId)` matches `AudioFeatureStatus`, including missingness across all current tracks, not just successful ones.
- `saveImportProgress` is a separate summary record and cannot overwrite A1's lease/checkpoint payload. `importProgress` reads A1's authoritative progress preferentially. DB inputs retain the shared names; no public DTO fields were renamed.

## Durable feedback reconciliation

Migration `007_feedback_sync.sql` adds one coalescing job per user and backfills existing nonzero feedback revisions. `settleDecision` updates this row in the same transaction as feedback, including SKIP replacement and Undo. No ML request runs in the database transaction.

The A-owned worker uses these `Repository` methods (`now`/`retryAt` are epoch milliseconds):

```ts
const claim = await repository.claimFeedbackSync(workerId, Date.now(), 120_000);
if (claim) {
  const snapshot = await repository.trainingExamples(claim.userId);
  // A sends /fit with snapshot.examples + snapshot.feedbackRevision and validates success.
  // Only after that successful response:
  await repository.acknowledgeFeedbackSync(
    claim.userId, claim.leaseId, snapshot.feedbackRevision,
  );
  // On retryable transport failure, instead call:
  // await repository.retryFeedbackSync(claim.userId, claim.leaseId, retryAt);
}
```

`claimFeedbackSync` returns `{userId,feedbackRevision,leaseId}` or null. The fitted snapshot may be newer than the revision observed at claim time. Acknowledgement only advances the delivered revision; newer target revisions stay pending. A stale/expired lease or a revision beyond the pending target returns false and cannot erase work. Failed/abandoned workers recover through lease expiry; retry times persist. Duplicate settlement does not enqueue again. All clients must use this queue for durable delivery rather than claiming a fire-and-forget `/observe` succeeded. Choose a bounded ML request timeout shorter than the lease (maximum permitted lease ten minutes). A owns retry policy, `/fit` authorization/transport and success validation; D owns persistence only.

## Analytics proof and recovery

Run `bun --env-file=../sort.fm/.env packages/db/src/inspect.ts` for safe schema/migration/hypertable/event counts. No credentials, track metadata or raw provider bodies are printed. The production table will remain empty until real application events are integrated; fixture tests are never presented as user behavior.

Tiger Data example (bind user ID and date bounds as parameters):

```sql
SELECT time_bucket('1 minute', occurred_at) AS bucket, model_version, event_type,
       count(*) AS events, avg(prediction_score) AS removal_score,
       avg(uncertainty) AS uncertainty, avg(processing_latency_ms) AS latency_ms,
       count(*) FILTER (WHERE event_type='decision' AND context->>'action'='ARCHIVE') AS archives
FROM sortfm.ml_telemetry
WHERE user_id = $1 AND occurred_at >= $2 AND occurred_at < $3
GROUP BY 1,2,3 ORDER BY 1;
```

Ordinary PostgreSQL uses `date_trunc('minute', occurred_at)` (as the portable repository query does). Real swipes/undos are recorded within settlement transactions; pending/failed commands do not fabricate successful decisions.

Before deployment migration, use Tiger Data's managed backup/PITR or take a restricted logical backup via standard PostgreSQL tooling. Protect backup files because they contain private library and encrypted credential data. Retain encryption keys separately. Test restoration to a separate service/schema; never reset production to test recovery. Schema migrations are additive and checksum tracked: recover a bad deployment using forward fixes or the separately restored service. After restoring DB + secrets, run migrations, start API/ML, then restart the same worker command. Completed caches persist, queued jobs resume, expired leases are reclaimed, and unfinished Spotify workflows require A2 reconciliation against Spotify before claiming success. Database recovery cannot reverse external Spotify mutations.

## Verification

```sh
bun run typecheck
bun run test
bun run build
TEST_DATABASE_URL=postgres://USER@localhost:5432/postgres bun test packages/db/test
RUN_SLOW_SOUNDNET_TEST=1 bun test packages/db/test/worker-slow.test.ts
```

For Tiger Data tests without copying or printing the connection URL:

```sh
bun --env-file=../sort.fm/.env -e 'const p=Bun.spawn(["bun","test"],{env:{...process.env,TEST_DATABASE_URL:process.env.DATABASE_URL},stdout:"inherit",stderr:"inherit"});process.exit(await p.exited)'
```

Tests create and clean only randomly named `test_*` schemas. Provider responses are mocked. The opt-in slow test runs a real local HTTP server with a 35-second response and verifies another HTTP path stays responsive. Live provider quality, production deployment, end-user swipes, PITR restoration and sustained 2,700-track throughput are separate integration gates.

### Review and Undo recovery (migration 008)

`createDecision` and `createUndo` atomically enqueue durable work. Both the immediate
API kick and the restart worker must call `claimReviewWork(workerId, nowEpochMs,
leaseMs)` before Spotify I/O. Claims serialize by **user**, including archive creation
across different tracks; independent users may run concurrently. DB time determines
expiry (the supplied clock value is validated, never trusted for ownership). Leases
last at most 10 minutes; renew while working. `ReviewWorkLease` contains
`{userId, decisionId, commandId, operation, leaseId, result, mutation}`.

Pass the lease to `transitionMutation(input, lease)`,
`settleDecision(userId, result, expectedStatus, split, lease)`, and
`setArchivePlaylist(userId, playlistId, lease)`. These writes take the same user lock
and validate ownership in their transaction. Expired or stolen leases fail with
`REVIEW_LEASE_LOST`; legacy unfenced calls fail with `REVIEW_LEASE_REQUIRED` while
any lease for that user remains active. `renewReviewWork`, `retryReviewWork`, and
`completeReviewWork` return false for stale tokens. Retry persists its next eligible
time. Completion requires a persisted terminal review or a settled Undo; it cannot
silently discard uncertain restoration. A crash after settlement but before completion
may return an already-terminal result on the next claim: retire it without provider I/O.

Before a non-idempotent POST, call `beginReviewEffect(lease, request)` with one of:

- `{kind:'create_archive', name, public:false, description}` (one durable intent per user).
- `{kind:'add_archive', playlistId, trackId}` (one per decision; owner playlist and track checked).

The returned `{effect, shouldExecute}` grants execution only for a new intent or an
explicitly retryable previous attempt. An existing `intent` means the POST may have
succeeded: read/reconcile its remote outcome, **never blindly repeat it**. Request facts
are immutable; changing the playlist, track, name or description fails with
`REVIEW_EFFECT_CONFLICT`. Read via `getReviewEffect(lease, kind)`. Resolve using
`settleReviewEffect(lease, kind, 'confirmed'|'retryable', remoteId)`; only a definitive
non-execution response (such as a classified 429) warrants `retryable` with null ID.
Timeouts, connection loss and ambiguous 5xx keep the intent unresolved. Confirmation
uses the playlist ID for both effect kinds; create confirmation atomically registers
the canonical archive playlist. Initial and recovered calls use these same records.

`getMutation`, `getPendingUndo`, `getDecisionByIdempotencyKey` and
`getUndoByIdempotencyKey` provide restart and HTTP retry lookups. Callers must compare
request identity before returning a lookup result; command creation remains the atomic
idempotency authority. Migration 008 backfills unfinished existing commands. No Spotify
transport or HTTP worker scheduling lives in this package.
