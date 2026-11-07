# B2 browser playback recovery

Recovery branch: `b2-sdk-playback-recovery`, based on `b24339bb38e873c413631c05e7144a888fe37489`. All changes are under `apps/web`. The interrupted `sort.fm-b2` worktree was copied into sibling `sort.fm-b2-recovery`; its HEAD and the 12 copied source files were rechecked unchanged. No provider calls, OAuth, personal labels, library writes, backend/DB edits, push or deployment were performed.

## Result

One owner-bound Spotify Web Playback SDK player serves calibration and review. Enabling the device never starts or transfers playback. An explicit Play gesture sends the displayed track and SDK device to the frozen backend route. Matching SDK events or state reads confirm playback; an accepted HTTP response alone cannot mark a song playing. The footer provides pause/resume, seek, supported volume/mute, Open in Spotify, and an initially disabled opt-in to play each new card. iOS uses hardware volume.

The SDK-only credential stays in short-lived memory and the SDK callback. The shared client enforces exact SDK scopes, owner, expiry, no-store and redirect refusal; the frontend rechecks owner and expiry before delivery. It never uses broad cleanup credentials. Owner changes, disposal and stale card completions are fenced. Listening and all player controls are independent of review/calibration mutations and journals.

Recovery corrections cover:

- Expiry during the final owner check; stale play during adapter authorization; stale resume during gesture activation or disposal.
- SDK track and disallow changes during a pending local control; mismatched audio is reconciled after the operation unlocks.
- Opting out while automatic playback is pending, and autoplay errors while a POST is unresolved. No ambiguous POST is automatically retried.
- Scoped playback reconnect responses preserve the primary login. Genuine primary authentication failures still invalidate it.
- Consent recovery stays visible while existing SDK audio retains local pause/mute/seek controls.
- Late connection checks and consent completions cannot update or redirect an unmounted owner session.

## Verification

- `bun test apps/web/src`: **142 passed, 0 failed, 529 assertions**, 14 files.
- `bun test` with DB/ML integration environment flags unset: **640 passed, 78 skipped, 0 failed, 3391 assertions**, 66 files. Integration skips are explicit; no DB was used.
- `bun run typecheck`: passed.
- `bun run --filter @sortfm/web lint`: passed, 41 files.
- `bun run --filter @sortfm/web build`: passed. Only upstream Zod/Rollup annotation warnings.
- `bun run smoke`: passed against an in-process synthetic foundation server, no Spotify calls.
- Independent source/fixture review: no remaining P0/P1/P2 findings; 73 focused tests and 223 assertions passed at review.

Browser acceptance was **not performed**: CUA focus/CDP is unavailable. Tests use fake SDK and HTTP fixtures, so they do not establish audible audio, Premium authorization, DRM or provider support. Backend availability remains a separate integration gate governed by `docs/integration/playback.md`.

## Acceptance after integration

The loopback fixture is available after a web build via `SORTFM_TEST_FIXTURE=1 bun apps/web/scripts/playback-preview.ts` at `http://127.0.0.1:5197/#/calibrate`. It is clearly labeled simulated/no audio, injects a fake SDK, and never contacts Spotify. Check desktop/mobile footer layout, seek/volume keyboard isolation, card/route changes, device loss, consent recovery and pending-play behavior. The fixture's request audit exposes playback and calibration requests for separation checks.

With the backend installed and an authorized Premium account, separately verify explicit grant consent, no audio on page load or enable, matching full-song audio on calibration and review, seek/pause/mute, opt-in next-card behavior, grant expiry, account changes and device loss. No personal feedback or cleanup mutation is needed for playback acceptance.

SDK method semantics follow the [official Spotify Web Playback SDK reference](https://developer.spotify.com/documentation/web-playback-sdk/reference).
