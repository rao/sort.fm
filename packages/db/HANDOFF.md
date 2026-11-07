# D handoff — Tiger Data, persistence and SoundNet

Implemented in isolated `d-data-soundnet` worktree from c35cd96, with integration-owned shared A1 port amendments f435ead/efe1c5c consumed as b4f792f/3dac6a9. Integrate the D implementation commit only; do not duplicate those shared patches. No merge to foundation/main was performed.

## Delivered files

- `packages/db/migrations/001_foundation.sql` through `006_swipe_context.sql`: transactional relational state, original snapshots, confirmed membership, immutable review commands/exposures, undo reservations, mutation journal, stable effective feedback, model runs, audio cache/queue, failures and Timescale telemetry.
- `packages/db/src/client.ts`, `migrate.ts`, `inspect.ts`: PgBouncer-compatible Bun SQL, checksummed migrations and safe operational inspection.
- `packages/db/src/repository.ts`, `a1-store.ts`, `soundnet-queue.ts`, `index.ts`: validated repositories, shared A1 adapter, worker leases/fencing/cache/progress/rate permits, and exports.
- `packages/db/test/{a1-store,normalize,queue,repository,settlement,worker-slow}.test.ts`: actual PostgreSQL integration and mock-provider checks.
- `apps/api/src/jobs/soundnet/{provider,normalize,worker,cli}.ts` and `worker.test.ts`: bounded asynchronous enrichment and operator commands.
- `packages/db/README.md`, `PLAN.md`, this handoff: commands, guarantees, recovery, interfaces and limitations.

No dependency, root configuration, OAuth, Spotify mutation, web UI, or ML training implementation added. A1 encryption is consumed, not reimplemented.

## Verification — November 7, 2026

- `bun install --frozen-lockfile`: passed; no lockfile change.
- Root typecheck, root web/API build, separate SoundNet CLI Bun bundle, foundation HTTP smoke: passed. Existing upstream Zod comment-annotation warnings remain nonfatal.
- Full root TypeScript suite with `TEST_DATABASE_URL` supplied from the real Tiger URL: **45 passed, 1 skipped**, zero failures. The skipped opt-in slow test was run separately and **passed** (35-second local mock provider while another HTTP path remained responsive).
- DB/provider suite against ordinary local PostgreSQL (only plpgsql installed): **21 passed, 1 skipped**. Confirms extension-free fallback.
- Foundation Python suite: **54 passed**. C1's concurrent feature branch is not claimed to be part of this branch.
- All six migrations applied to actual `sortfm` schema on Tiger Data; rerun `applied: []`, `hypertable: true`. Installed TimescaleDB is **2.31.0**. Inspection and actual `time_bucket` aggregation succeeded. Main DB at verification: **0 users, 0 tracks, 0 telemetry events, 0 cached features**, so aggregation truthfully returned no rows.
- A1 independently ran its full service integration test against these D files and actual Tiger DB: **1 passed / 10 assertions**. Encrypted OAuth persistence, paged 3-track import, reconstructed session, two refresh callers with exactly one mocked provider refresh, completed resync 3→1 with all original snapshots retained, and logout persisted. Spotify responses were synthetic, database real.
- Independent review found five defects; fixes/regressions cover in-flight undo reservation, membership/total settlement, current-versus-history reads, effective feedback revisions during pending replacement, and durable rate permits after rollback. A further cache/expired-running-job reconciliation defect is also fixed and tested.

DB tests create and remove isolated random schemas; none seed demo events into the real application schema. No actual SoundNet or Spotify requests were issued by D.

## Integration dependencies

1. A1/integration inject `new PostgresA1Store(connectDatabase())` into the auth/library services. A1 callback retries are bounded and only for definite 40001/40P01 rollbacks; never perform external effects inside these callbacks. Add `@sortfm/db: workspace:*` to API dependencies when wiring (API manifest belongs to integration/A).
2. A2 owns authentication, remote Spotify orchestration and reconciliation. Persist commands before calls, use CAS mutation journal, then `settleDecision` only after confirmed remote outcomes. `createUndo` reserves the decision until reconciliation/UNDONE settlement; competing reviews are blocked. Review `README.md` for revision/split semantics. Do not bypass pending undo reservations after ambiguous remote failures.
3. API queue reads `library(userId)` with nullable audio and currentDecision; filter statuses, playability and pending workflows. `library(userId,true)` is historical access. Completed membership snapshots and original saves are separate. Python receives `trainingExamples` via API/internal contract; feedback transport remains A2/integration-owned; follow-up durable reconciliation is described below.
4. After a real imported library exists, run the five-artist SoundNet smoke, inspect matching/latency/raw data, approve it, enqueue and start the separate worker. Exact commands are in `README.md`. Run/resume are identical. Source-use basis stays explicit in `SOUNDNET_RIGHTS_BASIS`; otherwise features are stored but not authorized for training.
5. Real end-user telemetry will appear after A2 calls settlement; the DB cannot claim a genuine swipe/demo chart before that integration. Frontend analytics route wiring and production deployment are not D-owned.

## Honest operational limits

Successful committed caches avoid repeated provider charges. A crash between receiving a provider response and committing it may require another request: provider-side exactly-once billing is unavailable. The shared limiter requires every worker with the same API subscription to use the same database/schema. Five requests per second is a cap, not a throughput promise; defaults are conservative, and 2,700 requests may be slow. Real provider schema/quality, production deployment, backup restoration/PITR, and sustained backfill completion remain unverified. They do not block metadata-only operation.

## Follow-up: durable revision reconciliation

Migration007 and Repository claimFeedbackSync/acknowledgeFeedbackSync/retryFeedbackSync implement the agreed A2 full-/fit delivery boundary. Coalescing enqueue is atomic with every effective feedback revision, including SKIP replacement/Undo, and existing nonzero revisions are backfilled. Tests verify newer revisions survive old acknowledgements, fits may acknowledge newer snapshots, retry scheduling persists, expired leases fence stale workers, idempotent settlement does not requeue, and a forced feedback-write error rolls back the revision and queue together. This slice is verified against local PostgreSQL; integration owns the next Tiger migration/run to avoid overlapping cloud suites. No transport was added.

Test-harness follow-ups also give settlement tests and A1 lifecycle hooks30-second cloud bounds; all DB clients are initialized only within enabled beforeAll hooks. Clean no-credential runs now skip DB tests instead of throwing DATABASE_URL_REQUIRED.

## Review recovery follow-up

Migration 008 adds per-user fenced review/Undo work and immutable non-idempotent
archive intents. Repository methods and exact transport responsibilities are documented
in README. Local PostgreSQL tests exercise crash reclamation, caller-clock spoofing,
expired/cross-user/legacy fencing, ambiguous intent reconciliation, immutable facts,
explicit retry scheduling and Undo completion safety. Integration lead owns applying
008 to shared Tiger; no concurrent cloud migration/test was run for this follow-up.

## Exposure safety follow-up

Migration009 and command guards preserve same-key retries after destructive removal,
serialize exposure consumption, reject stale exposures after settlement/Undo, and check
confirmed membership under the owner lock. Integration lead explicitly approved this
stricter internal behavior. API must map sanitized conflict codes and fetch fresh queue
exposures after Undo; timestamps originate on the server. Targeted local tests cover
concurrent distinct keys, owner/track mismatch, removed membership, exact-time staleness,
fresh post-Undo decisions and historical idempotency reads. Tiger application remains
with the integration lead.

## Rate limiter latency fix

Replaced the 250ms cross-transaction expiry requirement with a durable 30s crash hold
that shortens to 250ms spacing only after the request starts and the transaction commits.
A conservative monotonic remaining-time check retains rollback protection. Local
regressions inject 400ms DB latency, delayed SQL responses near expiry, competing
dispatchers, and post-start commit failure. No real SoundNet requests were made.

## Import/review membership race fix

Shared contract dependency: root commit 3143ef4 (locally cherry-picked as ee923f5).
Migration 010 adds membership_revision; A1 port reads/captures it before every scan pass
and passes expectedMembershipRevision on publication. Owner-locked CAS and durable
pending destructive-command checks prevent stale import overwrite of confirmed Unlike
or Undo, including expired worker leases. A1 owns baseline persistence/restart handling;
root integrates both slices atomically. Local PostgreSQL regressions reproduce the old
race and cover settlement, Undo, concurrent publication/command creation, rollback,
initial partial imports and missing baselines. Shared Tiger migration remains root-owned.

The regression suite also forces an old SERIALIZABLE import snapshot to overlap new
READ COMMITTED destructive-command/Undo creation. New command creation touches the owner
row without changing its semantic revision, so PostgreSQL aborts/retries the stale
import snapshot and the pending-command guard sees the new work.

## Live SoundNet acceptance and fallback (November 7)

The first five distinct-artist requests produced one valid cached response (1.795s),
two 90-second timeouts, and two HTTP200 bodies reporting `Failed to pull track data`.
The successful response's encoded title/artist identity matched the Spotify metadata;
its duration differed by only 200ms and all 14 normalized fields were present. No
schema normalization change was needed. The original failure report remains in
`provider_smoke` under `soundnet-review`; retry evidence is appended separately and
must not replace or hide that initial acceptance result. Bulk approval was not granted.

The known HTTP200 upstream-fetch error is now `PROVIDER_TRACK_UNAVAILABLE`, retryable
within the existing five-attempt budget (with backoff/concurrency reduction). Failed
smoke acceptance is exposed through sanitized `AudioFeatureStatus.reason`. Metadata
and already cached features remain usable; no fabricated features or Spotify mutations
are introduced. This fallback is the operational path until five acceptable samples
and explicit operator approval establish provider readiness.

One bounded retry of the original timed-out sample also timed out after 90,001ms.
It was appended to the original report's retries array; no bulk worker was started.
After the imported library reached 2,768 tracks, a repeat enqueue added 1,117 jobs;
2,767 uncached tracks are queued and the one valid result remains cached. Aggregate
audio missingness is 99.9639%; the verified cached vector itself has no missing fields.
