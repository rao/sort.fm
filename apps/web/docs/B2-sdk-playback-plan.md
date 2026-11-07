# Shared Spotify browser player implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved user request inline; obtain a fresh final review.

**Goal:** Listen to the exact displayed song in both calibration and cleanup with play/pause, seeking and supported volume/mute.

**Architecture:** One account-bound browser player survives card changes and navigation between the two workspaces. A frontend SDK adapter handles Spotify's official script/events and local controls; an independent store handles selection, generations, confirmed playback, errors and preferences. A1 owns isolated playback OAuth/token and backend target-device play/transfer; root owns shared contracts. Browser token exists only in SDK memory, never journals/logs/storage. Library and feedback mutations remain separate.

**Tech stack:** Existing React/TypeScript/Bun, official Spotify Web Playback SDK, frozen shared client. No dependency additions.

**Spec:** User approved the shared player proposal in this chat and authorized implementation/parallel coordination. Original B2 brief and master spec apply; the browser token exception requires root/A1 contract agreement.

## Constraints and review focus

- Only apps/web owned files; no root-owned vercel.json/shared contract/backend edits. Recovery branch b2-sdk-playback-recovery starts at b24339bb38e873c413631c05e7144a888fe37489 and preserves the interrupted original worktree unchanged.
- OAuth secrets and refresh tokens remain server-side; never expose broad cleanup credentials. API adapter uses the frozen boundary in docs/integration/playback.md.
- No audio before user gesture; automatic next-card playback is explicit opt-in. No label/cleanup request comes from listening, seeking, muting or playback completion.
- Changing cards during SDK initialization/token/HTTP completion must not play a stale selection. Requests serialize and state confirmation must match both device and song.
- Owner change/unmount disconnects and invalidates callbacks; token failures cannot leave misleading ready/playing UI.
- Premium/DRM/autoplay/device errors are explicit; Open in Spotify remains available. iOS volume uses hardware controls; no false mute indicator.
- SDK state events, not accepted HTTP requests, confirm playback. Seek/volume are bounded and controls respect Spotify disallows.

## Tasks

1. [x] SDK adapter (`src/data/spotify-sdk.ts`, tests): official script singleton, typed device/state/error events, bounded initialization, gesture activation, cleanup and injectable fake SDK. Test load failure, token callback rejection, ready/not-ready/state, disposal and retries.
2. [x] Account-bound player store (`src/state/browser-player.ts`, tests): approved backend adapter, exact selected-track play, stale generation fencing, async ready, volume/mute memory, seek/pause, optional auto-advance, failure/retry and device loss. Test owner change, card change during pending play, repeated clicks, token renewal/error, prohibited seek, empty/unplayable songs and no cleanup calls.
3. [x] Shared UI (`src/components/BrowserPlayback.tsx`, `App.tsx`, calibration integration and styles): one footer on calibration/review, selected artwork/title, enable/play/pause/reconnect, progress/seek, volume/mute and auto-next preference. Preserve B1 surfaces and keyboard isolation. Render missing capabilities honestly. Test controls/disabled states and existing review/calibration isolation.
4. [ ] Controlled fixture browser acceptance, root typecheck/test/build + web lint + foundation smoke, fresh independent review, focused commits and handoff. Real Premium playback/OAuth require actual backend and user-consent interaction; distinguish that from fixture verification. No personal labels or library writes for playback testing.

## Coordination ledger

- Root and A1 notified of user authorization and proposed separate playback credential boundary. The shared contract is now frozen in docs/integration/playback.md; this recovery uses that contract without modifying it.
- Provider-heading patch81eee2d is published separately and is not part of this branch.

## Recovery completion — 2026-11-07

Implementation and independent source/fixture review are complete. The root test suite passed 642 tests with 78 integration skips; the frontend passed 144 tests. Typecheck, web lint/build and no-provider foundation smoke passed. Task 4 remains unchecked because browser acceptance could not be performed while CUA focus/CDP is unavailable; real Premium OAuth, DRM and audible audio are separate acceptance gates. See B2-sdk-playback-handoff.md for the recovery fixes, verification and remaining acceptance steps.

Logout follow-up: clicking Sign out now disposes the shared SDK store before the server request, and removes the player UI for the rest of that App lifetime. Pending/rejected logout regressions verify late-token suppression, disabled audio operations and unchanged primary-session/error semantics. Fresh source review, frontend/root tests, typecheck, lint and build passed.
