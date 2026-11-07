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
