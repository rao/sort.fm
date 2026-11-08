# Batch3 persistence handoff

`PostgresCalibrationExperimentStore` implements the shared `CalibrationExperimentStore` from foundation872fe37. Import it from `@sortfm/db`. Candidate capture/reserve/private snapshot/seal are trusted operator operations; expose only experiment read/skip through A's service. No database CLI or browser reserve/seal endpoint is introduced.

## Deployment dependency

Additive017 follows016 through the normal migration runner. Never edit or reapply015 manually. Existing Batch2 rows, snapshots, vectors, train/holdout behavior and routes remain unchanged. Migration adds the Batch3 experiment constraint, phase/immutable receipt table, and admission/immutability triggers. Root owns the actual production migration, feature wiring and operator selection. This branch does not activate a panel or pilot.

Before017, experiment operations return BATCH_UNAVAILABLE; legacy paths work. Do not point the private pilot snapshot helper at a017 source: its current allowlist intentionally rejects it. Root must prevent pilot labeling and Batch3 reservation from racing, or install an authoritative common fence.

## Persistence behavior

All mutations share the user-row lock with review/feedback/library changes. Reserve validates the complete draft, seed commitment and all canonical hashes, then compares owner revisions AND the complete live eligible identity digest. Historical labels (including revoked/holdout), any retained review decision, calibration exposure, permanent batch assignment and known-track active policy reservation are excluded. External identity-only exclusions are additional. Unchosen adaptive pools and unlabeled ordinary review exposures remain eligible. The current implementation conservatively excludes every retained review decision, including terminal failures.

Exact reserve retries return the original receipt before live eligibility checks; changed full draft content raises IDEMPOTENCY_CONFLICT. Concurrent service requests with the same operator identity but different capture timestamps may reread the authoritative private snapshot after that conflict, provided A verifies every operator precommit/research/exclusion field against it. No recapture, rescore or overwrite.

Reserved public reads reveal only batch identity, phase, timestamp and40/20/0 counts. Existing labels, Undo, skip, exposure renewal and Repository.getExposure all enforce phase; direct table triggers also reject premature labels/Undo/skips/updates. Batch2's skip path rejects Batch3 identities both on fresh requests and replay.

Seal compares exact A candidate order, features and nullable primary artist IDs, recomputes stored hashes, binds the research/artifact digests, and verifies zero ever-feedback for every assigned initial track. Separate database clock observations enforce externalSealedAt <= checkedAt < readyAt; equality after millisecond conversion fails closed instead of inventing a time. Identical retries return the original receipt even after labels; changed content conflicts. Root must independently validate the external artifact bytes and trusted research identity: caller hashes alone do not establish scientific validity or precommit chronology.

After sealing, A skips remain permanent without replacement. B skips use the first unused, currently eligible member of the complete frozen B order. No assembly, scoring, model fitting or provider calls occur here. Undo renews only exposure identity using the same frozen candidate, following existing calibration freshness semantics. Training view from015 continues excluding every permanent A identity, including skips and revoked labels.

## Errors

BATCH_UNAVAILABLE; BATCH_NOT_READY; BATCH_NOT_FOUND; BATCH_INVALID_DIGEST; BATCH_CANDIDATES_CHANGED; BATCH_SEAL_MISMATCH; BATCH_SEAL_CHRONOLOGY; BATCH_FEEDBACK_EXISTS; BATCH_ITEM_NOT_FOUND; BATCH_ITEM_NOT_PENDING; IDEMPOTENCY_CONFLICT. Existing validation/user/eligibility errors remain applicable. Migration triggers return PostgreSQL errors containing the corresponding guard code; application paths check first and use PersistenceError.

## Verification

See the accompanying handoff for final commands/counts. Tests cover canonical commitments, exact replay, concurrent reservation, counts-only reserved projection, guessed-ID refusal, SQL admission/snapshot immutability, exact seal identities, clocks, training exclusion, Undo/restart, frozen B replacement, history and policy exclusions, migration rollback/reapply, and existing Batch2/C1 behavior. All live checks use generated `test_*` schemas and synthetic identities; cleanup drops only those schemas. No production migration/data mutation or real panel selection was performed.

Verified on this branch: full `bun test`957passed/172skipped/0failed (4995 assertions); `bun run typecheck`, `bun run build`, `git diff --check` passed. Separately,28 distinct actual Tiger Data tests passed across new Batch3 flow(4), migration rollback/reapply/legacy regression(4), and existing calibration/Batch2/policy compatibility(20,153 assertions), including the existing local C1 fitting check. A focused rerun verified the added revoked-feedback/backfill seal refusal. The original sandbox-only baseline failures were local socket binding restrictions; the same full suite passed with socket access. The expanded policy fixture initially attempted two simultaneous prepared selections; it was corrected to release its synthetic adaptive reservation, then passed. Independent review's Batch2 replay defect and reserved-exposure lookup gap were reproduced and fixed before completion.

Actual DB test invocation requires an explicitly provisioned `TEST_DATABASE_URL` through the secret environment, then `bun test` with the relevant packages/db/test files. Do not use the production migration CLI as a test command. Tests generate and remove their own unique schemas. Private local logs contain only synthetic test diagnostics and are not committed.
