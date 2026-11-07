# Calibration Persistence Implementation Plan

> Execute inline using superpowers:executing-plans; the frozen integration specification already authorizes this scope.

**Goal:** Persist owner-scoped preference labels and Undo without Spotify effects.
**Architecture:** Export PostgresCalibrationStore(db) implementing the frozen CalibrationStore. Add purpose and calibration tables; merge cleanup/calibration feedback through one latest-revision view used by training and cleanup settlement. Serialize all new commands on the existing owner lock.
**Tech Stack:** Bun, TypeScript, PostgreSQL, existing Zod contracts.
**Spec:** docs/integration/calibration.md and packages/contracts/src/calibration-persistence.ts at 981de79.

## Constraints and review focus

No live migration, Spotify calls, runtime/UI edits, C2 bindings, offline model imports, or historical exposure mutation. Preserve original save dates/status/membership. Wrong-purpose commands fail atomically. Same-key retries precede eligibility and return authoritative current state. Undo creates a tombstone, never revives older feedback. First persisted split survives every transition. Compare pending, terminal-failed, completed cleanup and Undo against the same unified winner.

## Tasks

- [x] Write disposable-Postgres tests for binary labels, detached retries, conflicting keys, cross-owner/purpose failures, exposure consumption/freshness, missing ownership/playability, concurrent commands and outbox atomicity.
- [x] Implement migration 012 with exposure purpose default review, separate calibration label/Undo tables and unified/effective feedback views. Preserve ml_training_examples column contract.
- [x] Implement PostgresCalibrationStore(db): advisory full-library candidates, transactionally checked exposure publication, label/revoke/replay/history. Reuse owner lock and outbox; derive deterministic new splits compatible with C1.
- [x] Update cleanup exposure purpose/freshness checks and settleDecision prior-feedback/split lookup. Test calibration→pending/failed cleanup→complete→Undo, superseded/revoked projections and no resurrection.
- [x] Run full tests/typecheck/build, disposable database migration apply/no-op/rollback checks; request independent review; document constructor/error codes and commit only D-owned files.

## Verified handoff

Export: `new PostgresCalibrationStore(db)` from `@sortfm/db`; existing `Repository(db)` remains the cleanup/training adapter. Migration 012 must precede API activation. No shared DTO changes, provider calls or live-schema migration are included.

Candidate setup requires published imported membership, not only saved tracks. Test seeding: after user/track upserts, use `new PostgresA1Store(db).transaction(tx => tx.completeImportMembership({userId, expectedMembershipRevision:0, jobId:crypto.randomUUID(), pass:0, trackIds, sourceTotal:trackIds.length, observedAt}))`. Use the actual expected membership revision for nonempty owners.

Errors: USER_NOT_FOUND, TRACK_NOT_OWNED, TRACK_NOT_IN_LIBRARY, CALIBRATION_NOT_ELIGIBLE, CALIBRATION_LABEL_ACTIVE, CALIBRATION_LABEL_NOT_FOUND, STALE_CALIBRATION_LABEL, MUTATION_PENDING, EXPOSURE_NOT_FOUND, EXPOSURE_TRACK_MISMATCH, EXPOSURE_PURPOSE_MISMATCH, EXPOSURE_ALREADY_CONSUMED, STALE_EXPOSURE, EXPOSURE_CONFLICT, IDEMPOTENCY_CONFLICT. Invalid shapes are Zod errors. Same-key retries are resolved before eligibility. Foreign identities are scoped and reported missing. The API owner maps errors to HTTP responses.

Verification on 2026-11-07:
- Full Bun suite with disposable local Postgres: 577 pass, 5 explicit optional-integration skips, 0 fail, 3346 assertions.
- Calibration and migration tests in disposable Tiger schemas: 7 pass, 65 assertions. Schemas dropped. Final additional null-label constraint assertion independently verified locally: 7 pass / 66 assertions.
- Existing real-C1 HTTP integration: 1 pass / 185 assertions. Initial full run failed its 30s ML startup readiness budget; after verifying Python import, isolated test and full rerun passed. No production changes needed.
- Typecheck and web/API build pass; build reports only existing dependency annotation warnings.
- Independent final review found no blockers. Exact tests cover outbox rollback, expired leases, cross-purpose/owner rejection, simultaneous commands, binary classes, pending/retryable/terminal cleanup, SKIP supersession, Undo tombstones, preserved split, imported membership/playability, fresh exposures, legacy purpose backfill, migration rollback and no-op reapplication.
- Real-C1 calibration-route end-to-end acceptance remains with A1/root after integration. This slice verifies unchanged training DTOs and cleanup reconciliation, not classifier efficacy.

Live migration and deployment remain integration-lead responsibilities. Musicae diagnostic files are outside Git and independent of this persistence commit.
