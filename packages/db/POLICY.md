# C2 persistence integration

`PostgresPolicyStore` implements the frozen `PolicyStore` in `@sortfm/contracts`. `Repository` implements the additive fit-receipt methods. This package performs no policy/model HTTP calls and never trains a model. Root owns deployment and strategy activation; A1 owns selection/recovery/delivery workers; C2 owns authentic policy decisions and receipts. C1 remains the default.

## Migration and compatibility

`016_policy.sql` adds six tables: owner sequence, actual fit receipts, selection intents, exposure bindings, release-command receipts and delivery events. It changes no existing table/view and backfills no historical policy association. Every permanent015 assignment remains excluded, including skipped, revoked and replaced cards. The migration runner locks by schema, checks checksums, applies transactionally and safely repeats as a no-op.

The integration lead can apply the migration from the integrated repository with the existing environment configuration:

```sh
bun --env-file=.env packages/db/src/migrate.ts
```

This command has **not** been run against the application schema by D. D rehearsed rollback, application and no-op repetition in generated disposable schemas only. Use the normal configured `DATABASE_URL` and `DATABASE_SCHEMA`; never paste credentials into commands or logs.

Genuine001–015 databases retain legacy cleanup settlement and numeric/actual fit acknowledgement. `recordPolicyFitReceipt` returns false there; the new policy adapter fails `POLICY_STORAGE_UNAVAILABLE`. A marker without all six tables, or policy tables without the marker, fails `POLICY_STORAGE_CORRUPT`; do not treat a damaged016 installation as legacy. Activate policy workers only after readiness passes. Rollback strategy is to disable policy activation/workers and retain016 data. Do not drop policy tables after real bindings/events exist.

## Issuance and recovery

- Read `currentSelection` first and serve only `servableExposureIds`. Original items/decision remain immutable history. Partial C1 release leaves the rest of the page available. `remaining` is base eligibility before queue reservations.
- `prepareSelection` durably freezes candidates/features/config/seed/model/revision and queue preference before remote I/O. UUID reuse with a changed semantic payload conflicts. Same request can reclaim an expired execution lease, but never extends the original intent deadline.
- C1 publishes one atomic page. Adaptive publishes one authenticated item, even for a larger queue limit. Publication rechecks confirmed membership, pending review/Undo, strong effective feedback, Batch2 exclusions and reservations under the shared owner lock, including changes without revision increments.
- Adaptive exposure telemetry, propensity, coefficient, serving time and provider reservation must match the exact decision. C2's cold-start `selectionMethod=c1` remains bound to its adaptive request and can seed committed policy feedback; ordinary C1 fallback creates no association.
- Published reservations use the earlier of the original DB intent deadline and authentic provider deadline. Clock rollback may put cached provider creation/closure times in the future relative to a later inspection; it never renews a deadline or reopens a terminal reservation.
- Execution leases are 1–120 seconds; fixed intent lifetimes are 30–900 seconds. Recovery changes the lease UUID. Background abandonment must supply `expectedLeaseId` so a stale request cannot close a newer attempt or published page.
- Stale/ineligible adaptive results enqueue durable release work. Unpublished exact404 inspection can resolve locally only after original expiry plus60 seconds, during the current live delivery lease. Both the DB lease start and DB acknowledgment time must reach that grace boundary; a pre-grace claim requires a new claim even if acknowledgment occurs later. DB acknowledgment time must not precede the lease start. The actual worker `checkedAt` is retained unchanged and must fall within `[lease_started_at - 500 ms, DB acknowledgment time + 500 ms]`; this fixed cross-clock allowance never shortens the DB grace or revives an expired lease. The stored disposition is `absent_after_deadline`, not a fabricated provider closure. A very late remote ghost reservation can remain until its own bounded expiry; it is never published or rewarded.

## Settlement, fitting and delivery

Only committed cleanup COMPLETE/UNDONE with an actual adaptive binding enqueues an immutable association/revoke in the settlement transaction. Event identity and payload are protected by a database trigger; owner/decision/operation dedupe prevents duplicate rewards. SKIP emits a null-label event using a separate owner sequence without inventing a C1 feedback revision. Calibration, old unbound exposures and C1 fallback create no associations. An outbox insertion failure rolls the settlement back.

Actual `FitResponse` receipts are validated for owner, schema, model consistency and nonfuture feedback revision. A successful feedback job acknowledgement writes its receipt atomically. Same-revision conflicting models fail `POLICY_FIT_RECEIPT_CONFLICT` and leave the job leased/unacknowledged. A newer actual receipt already covers an older job and is retained. Numeric-only acknowledgement never fabricates a model receipt. Manual/shared fits may call `recordPolicyFitReceipt` independently; no second fit or observe call is introduced.

Delivery claims the earliest unfinished sequence for each owner, with `SKIP LOCKED` across owners. An earlier delayed event blocks later policy events for that owner, not C1 fitting. Associations require a validated covering fit receipt; retries can attach a newer receipt while retaining the exact event. Only exact live leases acknowledge or reschedule. Retry codes are allowlisted, remote bodies are never stored, exponential backoff includes jitter and requested delays are capped at five minutes. A1's delivery worker should keep retrying transient errors within its circuit/scheduling controls.

Integration error mapping should include `POLICY_STORAGE_UNAVAILABLE`, `POLICY_STORAGE_CORRUPT`, `POLICY_SELECTION_BUSY`, `POLICY_CANDIDATES_CHANGED`, `POLICY_LEASE_LOST`, `POLICY_EXPOSURE_CLOSED`, `POLICY_EXPOSURE_CONFLICT`, `POLICY_RECEIPT_MISMATCH`, `POLICY_FIT_RECEIPT_INVALID`, `POLICY_FIT_RECEIPT_CONFLICT` and `IDEMPOTENCY_CONFLICT`. Do not log request bodies, library candidates or receipts as error context.

## Verification

The tests use generated users/tracks and isolated schemas. With a disposable PostgreSQL endpoint already in `TEST_DATABASE_URL`:

```sh
bun test packages/db/test/policy-eligibility.test.ts packages/db/test/policy-store.test.ts packages/db/test/policy-delivery.test.ts packages/db/test/policy-recovery.test.ts packages/db/test/policy-migration.test.ts
bun test
bun run typecheck
bun run build
```

The migration test hashes every preexisting table/view before and after migration, verifies transactional rollback and no-op repeat, checks genuine pre016 behavior and installed-schema corruption. Worker reconstruction, stale fences, ordered retry, actual fit advancement, clock rollback, outbox failure and atomic page failure are tested without provider calls. End-to-end HTTP integration and policy activation belong to root/A1/C2; database test success alone does not establish model quality or authorize deployment.
