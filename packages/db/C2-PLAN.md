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
- [ ] Bind this same predicate into selection publication after final reservation schema/DTOs arrive; ensure stale reads cannot bypass publication recheck.

## Remaining approved scope, gated on frozen DTOs

Root will supply exact selection-request/provenance/event/receipt shapes. Then expand this plan with concrete methods and tests before implementing migration016, intent recovery/publication CAS, release/expiry/replay, transactional settlement outbox, and fit-receipt persistence. No TODO-only public exports or speculative schema will ship.

## Verification and review focus

One fresh independent whole-branch review after implementation. Exercise rollback/no-op migration rehearsal on disposable actual Tiger schemas, stale worker fences, response-loss replay without lease renewal, membership/feedback/reservation races during remote selection, committed SKIP/revoke with unchanged C1 revision, and fit receipts that advance during delivery. Verify all old tables/views remain unchanged by migration and legacy C1 training works without016. Full suite, typecheck and build before immutable commit/handoff.

## Ledger

Ruling: plan stays under packages/db to respect ownership; no shared doc/contract edits. Root explicitly authorized phase1 now, so no additional human approval is needed. DTO-dependent work waits for root's boundary, not a guessed shape.


Phase1 ledger (2026-11-07): baseline736 pass/127 skipped/4004 assertions; four new eligibility tests failed NOT_IMPLEMENTED before implementation. Then local PostgreSQL and actual disposable Tiger Data each passed4 tests/21 assertions. Corrected fixture membership-revision expectations to include the initial publication increment (1 initially, 3 after Unlike/Undo). Typecheck passed after annotating the SQL-derived ID array. Default full suite736 pass/133 skipped/0 fail/4004 assertions; new actual-DB tests were separately run, not claimed exercised by that default run. No shared exports, migration016, production writes, or guessed DTO changes yet. Root informed that publication must recheck eligibility even when membership/feedback counters match, because pending KEEP/SKIP can leave both counters unchanged.
