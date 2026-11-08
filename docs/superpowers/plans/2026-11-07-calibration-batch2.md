# Calibration Batch 2 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. No parallel implementation needed.

**Goal:** A durable 70-label session in the existing calibration UI, with 25 sealed random evaluation tracks and 45 training tracks.
**Architecture:** Reuse calibration exposures, labels, Undo, owner locking and feedback outbox. Add batch reservations and frozen sampling snapshots. Filter sealed reservations before the shared ML training snapshot; never alter C1 or C2.
**Tech Stack:** Bun, TypeScript, PostgreSQL, Zod, React.
**Spec:** User's Calibration Batch 2 assignment in this chat; contracts coordinated with Master Overseer.

## Global Constraints
- Own branch c1-calibration-batch2; no merge or production migration by this agent.
- A=25 random sealed evaluation, B=25 diverse train, C=20 uncertain train.
- Never reuse historically reviewed/labeled tracks or change old split assignments.
- No Spotify mutation; no architecture, policy, tuning, or evaluation experiment changes.
- Predictions hidden during labeling. No invented calibrated uncertainty.

## Review Focus
- Concurrent creation/Skip/retry must not duplicate or silently regenerate membership.
- Old exposures and Undo must not bypass permanent sealed exclusion.
- Missing audio must not masquerade as an extreme musical region.
- A random selections must not depend on predictions or input order.
- Failed scoring, exhausted replacements, or membership changes must be explicit and recoverable.

## Tasks
- [x] Sampler: failing deterministic/exclusion/uniqueness/artist/age/audio tests; implement SHA256 seeded random ordering, rank-scaled farthest-point diversity, entropy uncertainty; freeze all candidate vectors and probabilities.
- [x] Persistence: migration015 sessions/reservations/skip commands; owner-locked create/read/skip with immutable provenance; same-group replacement from frozen pools. DB tests for restart, races, no side effects, historical exclusion and sealed isolation.
- [x] API: additive frozen shared DTOs and authenticated no-store/CSRF routes; existing label/Undo integration. Test malformed, owner mismatch, retries and model-version coherence.
- [x] UI: selectable Batch2, reuse existing cards/actions/recovery journal, persistent skip and completion counters. Test refresh/resume/recovery and score hiding.
- [x] Verify focused tests, root tests/typecheck/build and disposable DB checks; document algorithm, actual batch composition, limitations and integration handoff. Commit/push verified branch without merge.
