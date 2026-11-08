# C2 persistence implementation plan

> Execute inline using executing-plans and test-driven-development. Root approved eligibility/reservation invariant work before the final DTOs; do not freeze guessed wire fields. D owns only packages/db. Base: sanitized foundation4a9face.

**Goal:** Persist recoverable policy selections and committed cleanup associations without duplicating C1 training or admitting calibration rewards.
**Architecture:** Shared owner-locked eligibility, immutable selection intents and exposure provenance, bounded fenced reservations, ordered per-owner delivery outbox. Existing snapshot-fit transport remains independent. Add migration016; preserve frozen015 and every permanent Batch2 assignment.
**Stack:** Existing Bun, TypeScript, Bun SQL, PostgreSQL/Tiger, Zod; no dependencies.
**Spec:** Root's approved coordination messages; frozen shared C2 contracts/integration plan to be supplied by root before binding DTO-dependent code.

## Constraints

- No production writes, deployment, provider calls, real-library dumps, public push, old provider-branch merge, or C1 policy activation change.
- C1 default stays deterministic. Supported integration strategies are c1, epsilon_greedy, linucb; no new public random/config surface.
- All policies share strict confirmed current membership and pending/reviewed/reservation exclusions. Every015 A/B/C row, including skipped/revoked/replaced assignments, remains excluded.
- Strong COMPLETE remains excluded. SKIP may return only with a fresh exposure after closure. UNDONE may return only after committed restoration, no active feedback or other pending work, and no permanent reservation.
- Association/revoke events originate only from committed cleanup settlement with an actual policy binding. No calibration hooks or inferred historical associations.
- Separate policy sequence handles SKIP without fabricating C1 revision increments. C1 snapshot fit is never duplicated by observe or a second fit. Persist validated modelVersion/feedbackRevision receipts with fit acknowledgement; pending policy work cannot gate C1 training.

## Phase 1: approved invariant work

Files: `src/policy-eligibility.ts`, `test/policy-eligibility.test.ts`.
Internal interface: `readReviewCandidates(tx: Transaction,userId:string)` returns full current library context, distinct eligibleTrackIds, feedbackRevision and membershipRevision under the owner lock. Final public adapter port is root-owned.

- [x] Baseline current branch tests; install frozen lockfile offline.
- [x] Write real-PostgreSQL tests showing strict membership (including no library_state), owner isolation, pending review/Undo, strong COMPLETE, failed terminal, committed Undo, active calibration label and permanent Batch2 exclusions. Use generated data only.
- [x] Observe expected missing behavior, implement shared SQL predicate and return detached library/revision snapshot, rerun focused tests.
- [x] Bind this same predicate into selection publication after final reservation schema/DTOs arrive; ensure stale reads cannot bypass publication recheck.

## Remaining approved scope, gated on frozen DTOs

Root will supply exact selection-request/provenance/event/receipt shapes. Then expand this plan with concrete methods and tests before implementing migration016, intent recovery/publication CAS, release/expiry/replay, transactional settlement outbox, and fit-receipt persistence. No TODO-only public exports or speculative schema will ship.

## Verification and review focus

One fresh independent whole-branch review after implementation. Exercise rollback/no-op migration rehearsal on disposable actual Tiger schemas, stale worker fences, response-loss replay without lease renewal, membership/feedback/reservation races during remote selection, committed SKIP/revoke with unchanged C1 revision, and fit receipts that advance during delivery. Verify all old tables/views remain unchanged by migration and legacy C1 training works without016. Full suite, typecheck and build before immutable commit/handoff.

## Ledger

Ruling: plan stays under packages/db to respect ownership; no shared doc/contract edits. Root explicitly authorized phase1 now, so no additional human approval is needed. DTO-dependent work waits for root's boundary, not a guessed shape.


Phase1 ledger (2026-11-07): baseline736 pass/127 skipped/4004 assertions; four new eligibility tests failed NOT_IMPLEMENTED before implementation. Then local PostgreSQL and actual disposable Tiger Data each passed4 tests/21 assertions. Corrected fixture membership-revision expectations to include the initial publication increment (1 initially, 3 after Unlike/Undo). Typecheck passed after annotating the SQL-derived ID array. Default full suite736 pass/133 skipped/0 fail/4004 assertions; new actual-DB tests were separately run, not claimed exercised by that default run. No shared exports, migration016, production writes, or guessed DTO changes yet. Root informed that publication must recheck eligibility even when membership/feedback counters match, because pending KEEP/SKIP can leave both counters unchanged.


## Frozen semantic additions from root (port commit pending)

- `currentSelection(userId)` returns the newest published page's currently servable exposure IDs; preserve immutable original publication. Each GET/swipe must not allocate a fresh C1 page and strand nineteen cards. Snapshot `remaining` counts base eligibility before active queue reservation exclusions.
- `recordPolicyFitReceipt(userId,receipt:FitResponse)` supports actual shared fit completion including manual timeout completion, without acknowledging a job. Persist only validated monotonic nonfuture DB revision/model receipts; missing016 returns false. Optional FitResponse argument to legacy acknowledgement writes receipt atomically if ack succeeds, never fabricates from a number.
- Approved transport is root3112c89. C2 event immutable; latest covering receipt can advance across retries. No caller split, no model observe/fit, no historical/calibration association. Root telemetry3a77223 and transport3112c89 cherry-picked as d83241f/098c61c.
- `release_absent` local acknowledgement is allowed only for unpublished adaptive requests, exact owner/exposure, fresh actual404 checked during the current live delivery lease, no published binding, original expiry plus fixed60s grace passed. Store distinct absent_after_deadline diagnostic disposition, not a provider receipt. Never publish/reward a later ghost selection. Residual remote ghost lease can exist until C2's bounded TTL; C1 fallback maintains availability.

## Phase 2: final-port persistence implementation (start after root port commit)

Create `migrations/016_policy.sql`, `src/policy-store.ts`, `src/policy-delivery.ts`, and generated-fixture tests. Modify `repository.ts` only at fit receipt acknowledgement and committed settlement hooks; export concrete adapter from `index.ts`. Extend shared eligibility with active reservation exclusion and base remaining count. Keep016 readiness optional for legacy operation; never edit015.

- [x] Tests first for strict request identity, one adaptive request, atomic C1 page, request replay, current page reuse, payload conflict, expired/replaced lease fencing, immutable expiry, candidate drift with equal revisions, pending work, scope/owner/features/model pin mismatch, and failed-publication rollback. Observe red, implement minimal exact frozen port, rerun.
- [x] Tests first for deterministic settlement association/revoke uniqueness, separate sequences for label-free SKIP, no calibration/C1 historic rewards, original-exposure-only Undo closure, delayed/failed delivery independent of C1 fit, outbox rollback, and ordered retries after process reconstruction.
- [x] Tests first for FitResponse validation and owner/revision/model conflicts, no receipt from numeric legacy ack, same-transaction ack+receipt rollback, stale lease no receipt, manual completion receipt without ack, covering receipt at claim, updated receipt on retry and no immutable event mutation.
- [x] Tests first for release idempotency/subset closures, prepublication ambiguous release, expired recovery, exact404 after deadline+60s vs early/stale/future/foreign/published rejection, local absence disposition, late remote response rejection and no reward binding.
- [x] Migration rehearsal creates legacy001–015 fixtures, hashes every preexisting table/view, rolls016 back, applies once and reapplies no-op, checks preservation and no event backfill. Run in disposable local and actual Tiger schemas only.
- [x] Whole suite, focused actualDB tests, typecheck/build; one independent fresh whole-change review, fix blocking findings with regressions, immutable final D commit and root/A handoff. No live migration/deploy/public push.


## Completion ledger

Frozen port landed via root1bdf86e, ef4ee0a and9a0fdd2 (local94d7477,4ea3c38,6650687). Implemented016 and concrete adapter/repository hooks without shared-contract changes. First publication tests and first four delivery tests were observed failing against missing behavior, then passed. Subsequent recovery/migration tests validate implemented behavior; they are not claimed as red-first. Root's cold-start finding was reproduced before fixing binding detection. Independent whole-change review found missing-marker corruption, receipt conflict acknowledgement and telemetry mismatch; focused regressions reproduced these and the clock-rollback rejection before correction. One receipt test initially claimed another fixture's pending job; corrected it to fence its own generated job and re-observed the intended failure.

Initial final-scope verification: local full850 pass/12 skipped/5382 assertions; actual Tiger18 pass/132 assertions. After review fixes: focused local21 pass/149 assertions; typecheck/build passed. Final local full suite:853 pass/12 skipped/5398 assertions (865 tests across91 files). Final actual Tiger generated-schema run:21 pass/149 assertions, including migration rollback/reapply and all review regressions (155.26s). Build has only existing Rollup warnings about third-party Zod comment annotations. Production application schema, provider traffic and activation unchanged. Detailed runtime semantics and integration commands: POLICY.md.
