# Playback grant recovery hotfix

Branch `b2-playback-regression`, approved deployed base `9372e07`.

## Reproduced defect and fix

`BrowserPlayback` read grant availability only at mount or through the manual
Check connection action, recently hidden inside Options. If a token/control
failure revoked a grant later, cached availability remained ready. Reconnect
player retried device setup with the same invalid grant, with no visible consent
recovery path.

The existing availability effect now also runs on transitions into/out of the
SDK error state. Each transition performs one connection read (the adapter's
GET-only owner checks remain in place). It does not retry token requests, OAuth,
playback commands or library mutations. An unchanged error cannot trigger more
reads. Existing lifecycle generations discard superseded/unmounted results.

Check connection is visible when setup/recovery is needed. The main status
explains missing streaming/control stages and supersedes obsolete device errors
with the current authoritative missing-grant state. Healthy playback remains
compact; genuine device errors still appear outside Options. No CSS, backend,
credentials, shared contracts, or SDK transport changes.

## Verification

- Typecheck and production web/API build passed (existing Zod annotation and
  bundle-size warnings only).
- Web lint passed; frontend tests: 359 passed, 0 failed, 2,280 assertions.
- Existing playback tests cover play/pause/seek/mute, track changes, owner checks,
  late responses, relinked tracks, StrictMode disposal, and token boundaries.
- New rendering regressions cover both missing-grant stages, visible recovery,
  stale-error replacement, genuine device failures, and compact healthy state.
- Browser reproduction using the local synthetic SDK harness: before fix, repeated
  Enable/Reconnect failed while availability reads stayed at 2 (StrictMode mount).
  After fix, one failure caused read 3 and replaced Reconnect player with Connect
  Spotify playback + streaming recovery guidance. Reads stayed at 3 after later
  clock/poll updates. No OAuth/play/library writes occurred.

To repeat the browser regression: start the web dev server and open
`/scripts/playback-recovery.html` on localhost. Click Enable, then Inspect fixture.
The harness rejects all authorization writes, uses only synthetic songs, and is
not a production build entry.

## Release limitation

The user reports connected songs are not playing properly, without a reliable
error sentence. This fixes a reproduced recovery defect, but does not prove the
entire live symptom has the same cause. B2's browser is signed out; the overseer's
cached session reports account changed. No new permissions were granted and no
real Spotify audio was verified. After overseer deployment, verify fresh-session
grant recovery, Enable, Play, advancing time, pause, seek and mute before claiming
complete real-audio restoration. C2 and unrelated playback layout work stay out
of this patch.

## Silent-failure follow-up

Actual Arc screenshot showed Model Lab with Reconnect player and no failure
message. `BrowserPlayerStore.select()` cleared errors on every card/route change,
even with connection still failed. Preserve that error until an explicit new
connection attempt or successful recovery. A new regression fails on the old
behavior, covers leaving Review and selecting another song, and confirms a
successful reconnect clears it. Updated frontend suite: 360 passed, 0 failed,
2,286 assertions; lint, typecheck and production build passed again.
