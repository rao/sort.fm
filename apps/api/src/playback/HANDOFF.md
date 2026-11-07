# A1 isolated browser playback backend

Branch: `a1-browser-playback`, based on approved `2074b63`. Shared contract: `b24339b` (`docs/integration/playback.md`). Scope is `apps/api/src/playback/**` plus the optional dispatch hook in `apps/api/src/auth/module.ts`. No database, shared-contract, runtime or frontend changes.

## Composition

D supplies migration 014 and the exact `PlaybackStore` adapter. Root composes these instances once per process, before registering routes:

```ts
import {createPlaybackModule, PlaybackService, PlaybackControls} from './playback';

let playback: ReturnType<typeof createPlaybackModule>;
const spotify = createSpotifyModule({
  config, store: primaryStore,
  playbackCallback: (...args) => playback.callback(...args),
});
const service = new PlaybackService({config, store: playbackStore, auth: spotify.auth});
const controls = new PlaybackControls(service, {
  // Owner-filtered current library lookup; return null for missing/foreign tracks.
  track: (ownerId, trackId) => library.track(ownerId, trackId),
});
playback = createPlaybackModule({config, service, controls});
// Register both before buildApp installs foundation fallback routes.
await spotify.registerRoutes(app);
await playback.registerRoutes(app);
```

`library.track` above is an injected runtime adapter, not a new shared database method. It returns the established `TrackCard | null`. The controls service verifies Spotify source, matching track ID/URI and playability. Root retains exact-origin credentialed CORS and existing logger redaction/query-free request serialization. Do not log internal service return values, SDK responses, cookies or provider requests. The module logs only fixed error codes.

The shared registered OAuth callback is reused. Dispatch happens before primary OAuth state/cookies are touched; every `playback-` prefix fails closed without a working handler. Separate `sortfm_playback_sdk` / `sortfm_playback_control` cookies (production `__Host-` prefix) bind browser nonce, purpose and initiating primary session. PKCE verifiers, access and refresh credentials have owner/purpose-specific AES-GCM contexts. Primary credentials never enter this module.

## Runtime behavior

- Connection reports stored authorization readiness, not device or audible readiness. SDK and control consent are explicit, separate steps, SDK first. Both available returns conflict instead of unsolicited consent.
- Initial grants require explicit exact scope evidence and matching allowlisted `/me` identity. Refresh may omit scope only when retaining an already validated exact set. No primary credential fallback. SDK issuance rechecks profile, live session, version and expiry; only the exact SDK token DTO crosses the browser boundary.
- Refresh uses the shared live-session/version/lease fences. Provider requests run once with a 15-second default deadline (maximum 20 seconds), within the 60-second refresh lease. Contenders wait at most five seconds. Ambiguous/invalid refresh responses revoke only the fenced grant. Token-endpoint 429 retains the prior grant; failure after a rotating exchange revokes it. Root/D must keep database operations bounded and provide atomic port behavior.
- Play validates current owner library membership and an unrestricted explicit device, rechecks session/version after preflight, and sends exactly one URI to the URL-encoded device ID. Transfer is an explicit separate operation, one device and `play:false`; it preserves provider playback state and does not promise silence. There is no automatic transfer, autoplay, legacy `/api/player/play` implementation, or command replay.
- HTTP success acknowledges an accepted command only. GET status 204 means no active playback. SDK events establish actual playing/track state; SDK seek/mute remain B2 responsibilities.
- All routes enforce strict contracts, empty queries, owner session, unambiguous cookies and POST Origin/CSRF. They set no-store/no-referrer/nosniff and return fixed safe errors. Reconnect uses the frozen 401 code; B2 must distinguish `PLAYBACK_RECONNECT_REQUIRED` from primary session loss.
- Logout fences future issuance. It cannot invalidate a bearer already delivered to browser memory before the provider expiry. This narrow browser token exception is documented and approved in the frozen integration contract.

## Verification and remaining gates

Controlled tests cover exact/missing/expanded/duplicate scopes, PKCE, wrong owner, browser/purpose binding, denial/replay, logout during callback/refresh/issuance, concurrent refresh, newer consent, short-lived expiry, token429 versus post-rotation failure, fixed provider errors/deadlines, no automatic replay, explicit device/URI, restricted/missing device, unavailable track, truthful status, callback isolation, production cookies, strict routes and existing primary OAuth regressions.

`test-support.ts` and `fixtures.ts` are controlled test doubles, never imported by production exports. They do not prove PostgreSQL locking, migration application or live provider behavior. Before activation, root must integrate D014 and test these services against its real adapter, then validate the exact scopes actually returned by Spotify for both grants, Premium/browser SDK availability, real play/seek/mute, logout teardown and credential-free telemetry. If Spotify returns a broader grant, this backend intentionally rejects it; do not filter scopes to pretend the bearer was narrowed. No live OAuth, playback, provider or production database calls were made for this handoff.

Verified on this branch: `bun test` — 630 passed, 78 skipped, 0 failed, 3,515 assertions. Focused playback plus primary callback suite — 33 passed, 272 assertions. `bun run typecheck`, `bun run build`, and standalone `bun build apps/api/src/playback/index.ts --target=bun` passed. Build emits existing third-party Zod/Rollup annotation warnings. Independent read-only review found no outstanding actionable issues. Skipped database tests and live-provider acceptance remain unverified here.

Follow-up concurrency fix: integration review found that simultaneous and staggered callers could rotate a newly published 30-second token while another caller was still validating its profile. Credential acquisition now reuses genuinely unexpired grants, without a fixed proactive refresh skew. Frozen persistence has no original TTL/issue-time metadata; no new metadata or contract changes are introduced. Existing scope, owner, live-session, final-version and expiry fences remain intact. If credentials expire during profile/preflight, the current request fails closed. A provider 401 for a now-expired access token preserves its refresh credential for the next request; an unexpired 401 still revokes only the expected version. Control commands are never replayed.

Five new regression tests cover simultaneous callers (one refresh, five matching responses), initially-fresh staggered callers, expiry during successful profile validation, provider 401 at expiry versus before expiry, and control expiry during preflight or one attempted command. Concurrency and expiry401 regressions failed before their fixes. Final follow-up verification: 635 passed, 78 skipped, 0 failed, 3,555 assertions; focused suite 38 passed / 312 assertions; typecheck and build passed. Independent follow-up review found no remaining blocker. Production persistence and live-provider gates are unchanged.
