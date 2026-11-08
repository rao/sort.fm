# Connected Music Desk Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the approved retro music desk the submission app, with the existing real Spotify, playback, calibration, history and model flows.

**Architecture:** Keep ConnectedRoot, ReviewStore, CalibrationStore and BrowserPlayerStore as the functional owners. Replace App's visual shell and review presentation with small shared MusicDesk components; theme the existing rich route components instead of duplicating their data logic. The separate draft remains a design reference, never the production data source.

**Tech Stack:** Existing React 19, TypeScript, Bun, BoardUI/React Aria controls, CSS semantic tokens, existing swipe physics and reduced-motion support.

**Spec:** `docs/handoffs/pocket-player-draft.md` plus user's explicit request to wire the approved design into real flows now, ready for submission.

## Global Constraints

- Preserve current auth/session handling, read-only capability guards, idempotent decisions/recovery and honest data provenance.
- Preserve Batch 2/3 calibration component/state and hidden predictions; integration lead owns concurrent calibration edits.
- No fake model metrics, fake playback, fabricated collection totals, or synthetic songs in Spotify sessions.
- Navigation words: Sort, Teach, Library, History, Model. Import/sync and original rich Inspector remain easy to reach.
- No success toast; Undo is persistent, disabled without fading. Failure and ambiguous-outcome recovery remain visible.
- Optional model/context and playback controls; keyboard navigation and reduced motion remain supported.
- User's chunky retro direction overrides generic BoardUI card shape defaults; retain source-owned accessible controls and semantic theme colors.
- No backend/contracts changes, provider writes during QA, push or deployment. Integration lead merges and handles submission deployment.

## Review Focus

- Authenticated but bootstrap unavailable: preserve account identity, retry/import paths and no fake zero counts.
- Read-only sessions / pending mutation / stale queue: prevent destructive controls and retain recovery actions.
- Hiding playback must not dispose/recreate a playing SDK session or stop its state tracking; an explicit close hides controls only.
- Calibration selection must still drive playback and never expose review predictions/commands.
- Long track/account names, small viewport, tall playback errors, and reduced motion must retain usable controls and content.

### Task 1: Shared connected shell

**Files:** Create `apps/web/src/components/MusicDesk.tsx`, `apps/web/src/components/music-desk.test.tsx`, `apps/web/src/styles/music-desk.css`; modify `App.tsx`, `main.tsx`, `styles/scrollbars.css`.

**Interfaces:** MusicDeskChrome consumes route, optional AccountSession, remaining count, toggles and account callback. It produces a truthful profile/status and one-word navigation. App continues to own stores, route and playback lifecycle.

- [x] Add rendering regression tests for live account identity, missing count (not zero), demo labeling, active route grouping and reachable Model/Inspector/Sync links.
- [x] Run tests red, implement shell/chrome and semantic tokens, then rerun green.
- [x] Replace App header with shell, add night/detail/playback toggles, preserve route contents and recovery controls. Remove only success toast; keep screen-reader announcement.
- [x] Keep BrowserPlayback mounted when controls are hidden, include visibility in footer measurement and keyboard pause rules.

### Task 2: Connected MP3 player and rich screens

**Files:** Create `components/ReviewPlayer.tsx`; modify `components/SwipeCard.tsx`, `components/Landing.tsx`, `components/History.tsx` only as needed, plus the shared theme.

**Interfaces:** ReviewPlayer consumes current/next QueueItem, action lock, removal capability, authoritative latest undo, and callbacks owned by App. It delegates swipe physics to SwipeCard and decisions to the existing store. Existing ModelPanel/Insights/ModelLab/Calibration/ConnectedLibrary/Dashboard retain data and commands.

- [x] Test actual Spotify song/artist/date/artwork, destructive capability locks, pending/refresh locks and persistent Undo; assert no fixture artwork substitution for live songs.
- [x] Run red then implement tactile device around real SwipeCard, directional buttons with thumbs-down, exact archive/unlike copy and Details/Listen controls.
- [x] Theme rich route panels, import progress, history, calibration, Inspector, playback, account/recovery dialogs and landing page consistently; retain all existing controls and details.
- [x] Run frontend suite and inspect demo routes at desktop/mobile, including keyboard decision/Undo and dialog behavior.

### Task 3: Submission verification and handoff

**Files:** Update `docs/handoffs/pocket-player-draft.md` with production integration and validation.

- [x] Run root typecheck, web lint, frontend and root tests, production/draft builds.
- [x] Browser verify landing and auth errors, explicit demo, sorting and Undo, history, library/import, Teach gate, Model/Inspector; check desktop/mobile/night/reduced-motion behavior and content overflow. Verify live fixtures with existing tests; report any real-account acceptance not exercised.
- [x] Request focused independent review of the new shell/data/lifecycle boundary; fix material findings and rerun relevant checks.
- [x] Commit only UI integration changes and send additive SHA, scope and exact acceptance limits to Master Overseer. Present working app URL and screenshots to user.

## Execution ledger

- Base: bf24df3 plus standalone 1814466; prior 8dc14ce remains immutable. Existing UI worktree reused on ui-boardui-foundation.
- Baseline frontend: 214 tests passed, 953 assertions, no failures.
- Ruling: User already approved the visual direction and explicitly requested immediate integration. Execute natively without another design/plan approval loop.
- Ruling: Reuse rich production route components rather than replace them with the reduced draft fixtures; this preserves concurrent backend/model work and all existing safety behavior.

- Final checks: root 1030 pass / 182 skip / 0 fail / 5556 assertions; web 239 pass / 1117 assertions; typecheck, all-web lint, both builds and foundation smoke passed.
- Review resolved persistent Undo after exhaustion and touch-action cancellation. Browser completed demo routing and responsive checks; real-account acceptance is explicitly handed to the integration lead during the coordinated source-data pause.
- Browser resize API failed on stale tab12. A fresh 1280×720 tab and temporary390×844 iframe verified layout; removed QA page afterward. No production requests or Spotify writes used for UI QA.
