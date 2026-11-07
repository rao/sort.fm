# A2 cleanup verification and hardening

**Goal:** Verify the integrated cleanup module against the A2 brief, close unsafe response-validation gaps, and hand off a focused branch without changing shared contracts.

**Baseline:** Approved foundation `d6d55b4`; existing workflow originally implemented at `536b346` (A1 branch equivalent `87a3bb7`). Worktree: `sort.fm-a2`, branch `a2-cleanup-hardening`.

**Architecture:** Retain the durable D repository, per-user worker lease, journaled playlist effects, authoritative ML snapshot outbox, and existing public routes. Spotify remains mocked; database checks use isolated synthetic test schemas. No frontend, DB, contract, or runtime edits.

**Acceptance references:** User's A2 request; `sort-fm-agent-handoffs/sort-fm-agent-handoffs/A2-safe-review-mutations.md`; master spec v1.1; `docs/contracts.md`.

## Tasks

- [x] Write failing adapter tests for missing, contradictory and wrong-type playlist identities and wrong playlist response IDs. Reject untrustworthy reconciliation without converting it to absence or confirmation. Preserve valid current/legacy item shapes, local and unavailable items, and relinked tracks.
- [x] Expand worker regression coverage: archive creation/insertion failures; ambiguous create/unlike/restore; archive deletion after confirmation; database settlement interruption; Keep/Skip Undo; rejected playlist insertion retry deadlines.
- [x] Exercise public routes with mocked sessions: absent/expired/duplicate cookies, CSRF, forged user fields, pending outcomes and retry envelopes. Exercise durable HTTP workflow and C1 feedback using existing opt-in integration tests.
- [x] Run root tests/typecheck/build, relevant DB/ML integration checks and independent review. Record exact results and limitations in the A2 handoff.

## Review focus

Malformed provider state must never prove safe deletion. A timeout can commit remotely. Crash recovery must not duplicate playlist POSTs or preference labels. Undo retains the active label until confirmed restoration. Concurrent request keys must not consume one exposure twice. Background retries must honor persisted deadlines.

## Decisions

Keep the shared P0 contract: archive Undo retains the archive copy; Undo targets the current decision for its track; ambiguous playlist POSTs with no visible effect remain unresolved instead of risking duplicates. The live owner-account smoke is a separate acceptance gate, not something mocked tests can prove.

## Verification record

Adapter safety regressions failed before implementation. Independent review caught bare-ID and nested relinked identity variants; three more regressions failed before the fix and passed afterward. Final root suite: 281 pass / 56 opt-in skips / 0 fail; typecheck/build/smoke pass; Python 228 pass. Final Tiger/C1 backend and DB atomicity run: 7 pass / 168 assertions. Additional queue, partial-workflow, durable lease and feedback integration checks passed; see HANDOFF.md for exact run boundaries and the initial environment startup failure. No shared-contract changes, no deferred review findings, no live Spotify mutation claim.
