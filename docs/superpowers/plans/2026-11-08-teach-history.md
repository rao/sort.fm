# Teach and music history implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Teach a permanent preference-only product flow and add stable historical/current Constellation views.

**Architecture:** Reuse calibration label/Undo/Skip infrastructure with an ordinary-only client and journal, a separate public Teach presentation and the existing internal research view. Consume integration-owned readonly Teach status/history and Constellation v2. Cache only acoustic geometry across route changes; labels and membership refresh independently, and view filters preserve the full historical embedding and camera.

**Tech Stack:** Existing React, TypeScript, Bun, Vite, BoardUI, Canvas 2D and worker.

**Spec:** User's two final product refinements in this chat, 2026-11-08; exact backend decision coordinated with master overseer.

## Global constraints

- No Spotify membership/playlist mutations from Teach. Still love it = 0 Keep; Outgrown = 1 Remove; Unsure = session Skip, no supervised label.
- Preserve research routes, protocols, assignments and sealed cohorts; public navigation cannot select research sessions.
- Never expose excluded identities/labels through nodes, neighbors, details or counts. Backend owns authoritative eligibility.
- Separate preference from synchronized membership. Use only confirmed counts/revisions, never a completion percentage.
- No edits to History, ReviewStore, live-client, backend/shared packages, C1/C2 or Batch 3 algorithms.
- Frontend worktree only; local verified commit and handoff, no independent merge/deploy.

## Review focus

- Remembered research session and ambiguous research commands must not leak into public Teach.
- Saved label/Undo succeeds while optional status refresh fails: keep outcome and show sync unavailable.
- Current-view filtering must hide a historical track from hover, keyboard, search, details and neighbor links as well as the canvas.
- Label/membership/Undo refresh must preserve coordinates and camera; geometry changes alone can rebuild.
- Auth changes/failed privacy reads must not leave an old account's graph visible.

### Task 1: Public Teach

Files: new `apps/web/src/components/teach/**`, narrow `components/Calibration.tsx`, `state/calibration.ts`, `data/calibration-client.ts`, tests and narrow `App.tsx` route wiring after root base handoff.

Interfaces: existing calibrationQueue/Label/Undo; new integration-owned GET `/api/calibration/status` with trainingFeedbackCount, feedbackRevision, synchronizedFeedbackRevision, modelVersion; GET `/api/calibration/teach/history` with existing CalibrationHistorySchema. Existing research history untouched.

- [x] Add tests for ordinary-only journal, no research reads, Keep/Remove/Skip/Undo calls, no Spotify mutations and status failure/revision semantics.
- [x] Implement safe ordinary Teach client + status presentation and reuse keyboard/swipe card mechanics.
- [x] Route public Teach to ordinary store and preserve explicit internal research view without public batch buttons.
- [x] Verify focused state and presentation tests; review demo/mobile/error/recovery states.

### Task 2: Stable graph views

Files: dedicated `components/taste-constellation/**`, narrow `ModelLab.tsx` and `App.tsx` prop wiring.

Interfaces: new GET `/api/ml/constellation/history`, schema `sortfm.constellation.v2`, existing strict audio/label/prediction shape plus track isLiked:boolean and top membershipSyncedAt:timestamp|null. Preserve deployed v1 endpoint.

- [x] Test graph filtering, coordinate equality, eligible labels independent from membership, refresh/Undo and stale-response handling.
- [x] Add view selectors and membership explanation, reuse a full-history embedding cache keyed only by IDs/audio.
- [x] Update canvas to redraw visibility/labels without resetting camera; apply visibility to edges, neighbors, keyboard, tooltip, search and counts.
- [x] Refresh at settled action revisions, route activation/focus and explicit refresh; preserve readonly errors and explicit demo separation.

### Task 3: Verify and hand off

- [x] Incorporate exact integration-owned shared contracts and required new base without editing those files.
- [x] Run typecheck, focused/full tests, web lint, production build and relevant smoke.
- [x] Verify browser using only authored fixtures; preserve actual account/evaluation data privacy.
- [x] Independent review, fix concrete findings, commit focused frontend work, send master short tested handoff.

Baseline at e921909: typecheck passes; 1,091 tests pass, 219 skipped, 0 failed.

Verified on shared-contract base `07fd43d`. Backend implementation remains integration-owned (`5f2ce66`). See `docs/handoffs/teach-history.md` for exact checks and handoff.
