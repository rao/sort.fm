# Playback persistence implementation plan

> Execute inline with the executing-plans and test-driven-development skills. Root explicitly requested implementation against the approved frozen port; no further design approval is needed. All changes remain D-owned.

**Goal:** Implement `PostgresPlaybackStore(Database)` and additive migration014 without changing primary credentials, library/calibration feedback, or provider behavior.
**Architecture:** Separate playback grant and OAuth-attempt tables; one owner lock and serializable transaction per operation. Validate a live primary session/account inside that transaction. Keep consumed/completed attempt markers, exact-purpose scope sets, opaque encrypted envelopes, and version/session/lease fences. No provider I/O or automatic ambiguous-commit retry.
**Stack:** Existing Bun/TypeScript, Zod, PostgreSQL/PgBouncer tooling; no dependencies.
**Spec:** `packages/contracts/src/playback-persistence.ts`, `docs/integration/playback.md`, A1 `apps/api/src/playback/HANDOFF.md`; approved base9965249.

## Constraints and rulings

- Only `packages/db/**`; root owns activation/readiness wiring and every live migration. No live014, OAuth calls, primary-auth API edits, Spotify writes, or UI changes.
- Preserve full frozen port and `PostgresPlaybackStore` export. A1 supplies cryptography, namespace generation, allowlist and actual owner/profile verification.
- Error alignment: `AUTHENTICATION_REQUIRED` for invalid primary session/account, `STATE_CONFLICT` for insert/version conflicts, `OAUTH_STATE_INVALID` for invalid consume evidence/replay/expiry, `PLAYBACK_SCOPE_REJECTED` for exact-scope failure; malformed input/envelopes use fixed safe errors. Never import API error classes.
- CAS misses return false/null as specified after live-session validation. Revocation has no session context and remains version/optional-lease fenced, allowing cleanup after logout without changing primary login.
- Time checks include elapsed lock/transaction waiting added to caller-supplied server `now`; do not rely on stale pre-lock time or replace the caller's test clock with host wall time.
- Primary re-login deletes old sessions; expired/deleted sessions and revoked primary accounts fence every session-context operation. Owner/version/lease rules prevent old work from clearing newer consent.

## Task 1: Durable port and migration

Files: create `migrations/014_playback.sql`, `src/playback-store.ts`, `test/playback-store.test.ts`, `test/playback-migration.test.ts`; modify `src/index.ts` and migration expectations in existing tests. Handoff `PLAYBACK.md`.

- [x] Add failing real-database tests for consume/publish once, bad evidence not consumed, SDK/control and owner isolation, exact scopes/encrypted input, detached reads, expected-version conflicts, refresh contention/expiry/replacement/revocation, logout/expiry/primary re-login, rollback and preservation of existing tables.
- [x] Observe red failures against a minimal unimplemented port, then implement the exact port with separate tables and atomic guards.
- [x] Verify migration014 rollback and reapplication/no-op on disposable local and actual Tiger schemas; preserve prior schema data and checksums.
- [x] Run targeted tests, full Bun suite, typecheck/build and independent whole-change review. Fix consequential findings with red/green regressions.
- [x] Commit focused changes, report immutable SHA and exact readiness queries; no production migration or activation.

## Review focus

Late session expiry after waiting on an owner lock; stale worker versus replaced/expired leases; cross-owner/purpose state collisions; malformed persisted credentials or unexpected input; races with primary logout/re-login and rollback after partial writes. Tests must exercise these boundaries through PostgreSQL rather than mock storage.

## Verification ledger

Initial sandbox baseline could not bind local sockets (three tests failed with listen errors). The baseline rerun with local-network permission and disposable PostgreSQL passed; no implementation changes preceded that baseline.

Baseline rerun passed: 709 tests, 12 skipped, 4,323 assertions. The initial six port tests and migration absence check failed before implementation. Ruling: revokeGrant strips structural extra fields (A1 passes a refresh-fence object including initiatingSessionHash) while validating only the frozen revocation keys; that hash is not an authorization input for this non-session port. Public request DTO strictness is unchanged. Rejecting that valid structural call would break A1 cleanup after refresh.


Final verification (2026-11-07): full Bun suite with disposable local PostgreSQL: 719 pass, 12 skip, 0 fail, 4,419 assertions across 74 files. Focused playback tests on local PostgreSQL and actual Tiger Data: 10 pass, 0 fail, 97 assertions each. Actual Tiger migration rollback/reapplication and preexisting-table hash preservation passed. Typecheck and production web/API build passed; build emitted existing third-party Zod annotation warnings. No application-schema migration or provider calls were made.

During verification, corrected the test fixture to parse the branded ID through IdempotencyKeySchema (the convenience helper is not exported from the root contracts entry point). Corrected the contention test to capture a settled promise before asserting: Bun's chained rejects matcher blocked the test's subsequent unlock step and caused lock_timeout, while the adapter behaved correctly. The corrected test demonstrates AUTHENTICATION_REQUIRED after elapsed expiry on both databases.

Final review: independent fresh-context reviewer found no Critical/Important issues. Final: minor (deferred): add a direct concurrent primary logout/re-login versus playback-completion regression; current tests cover sequential invalidation and delayed expiry under owner contention. Reviewed lock ordering remains correct with serializable rollback retries.

Ruling: keep branch/worktree for the integration lead rather than merge or present another approval menu, following the human's explicit coordination and ownership instructions. No production activation is implied. Cost if wrong: integration remains pending rather than making an unauthorized merge.

Ruling cost for structural revokeGrant extra fields: unknown internal properties are ignored; only the frozen owner/purpose/version/optional-lease keys authorize the write. This does not relax public DTO validation. If the caller mistakenly depends on an extra field as a fence, that fence is not enforced; callers must use the frozen port.
