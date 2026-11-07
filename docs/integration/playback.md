# Browser playback contract and integration plan

Status: A1 backend/OAuth is integrated; B2 SDK UI is staged on the integration branch. D persistence/migration and runtime acceptance remain pending. Do not publish the staged UI to the Vercel production branch before the playback backend is deployed. Production calibration is independent. `CONTRACT_VERSION=1.0.0` and `FEATURE_VERSION=sortfm.features.v1` are unchanged.

## Authorization and credential boundary

On November 7, 2026 the user explicitly requested real-song playback with seek/mute in cleanup and calibration, then authorized implementation after B2 explained that the Web Playback SDK requires a browser access token. The integration owner verified those user turns. This is a narrow exception to the master specification's server-only Spotify-token rule: **only an owner-bound SDK access token with the exact scopes below may reach browser memory**. Provider keys, client secrets, refresh credentials, primary library credentials and playback-control credentials remain server-side. `AccountSession` remains credential-free.

| Grant purpose | Exact requested and accepted scopes | Consumer |
|---|---|---|
| `sdk` | `streaming`, `user-read-email`, `user-read-private` | Browser SDK access token only |
| `control` | `user-read-playback-state`, `user-modify-playback-state`, `user-read-private` | API only |

Spotify's [SDK guide](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player) specifies the SDK trio. The control grant's private-profile scope is specifically approved for independent same-owner `/me` verification; it does not authorize returning the control token or profile email to the browser. Spotify lists the profile endpoint under [user-read-private](https://developer.spotify.com/documentation/web-api/concepts/scopes#user-read-private). Do not infer identity from a browser-supplied owner or the fact that consent occurred in the same browser.

Validate the provider's actual initial granted scope set before storage and again before issuance: exact membership, no omitted/extra/duplicate scopes. Filtering the returned list cannot narrow a broadly scoped bearer. Initial missing scope evidence fails closed. On refresh, an omitted `scope` may retain only the previously validated grant's exact set; a supplied broader/missing-member set rejects the refresh and revokes that fenced grant only. Never fall back to the primary account token. Preserve the provider's actual expiry; do not invent a fresh hour when returning a cached token.

## Frozen public wire

All schemas are strict. Owner/session comes from the HttpOnly session; requests accept no scope, owner, OAuth purpose, credential or arbitrary return URL. All POSTs require exact configured Origin and CSRF checks. Empty queries are required. Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and existing exact-origin credentialed CORS on success and failure.

| Method/path | Input | Output |
|---|---|---|
| GET `/api/player/connection` | Empty query | `{status,sdkReady,controlReady,reason}` |
| POST `/api/player/connect` | `{returnTo:"review"|"calibration"}` | `{authorizationUrl}` |
| POST `/api/player/token` | `{}` | `{ownerId,accessToken,tokenType:"Bearer",expiresAt,scopes}` |
| POST `/api/player/sdk/play` | `{trackUri,deviceId}` | `{ok:true}` |
| POST `/api/player/transfer` | `{deviceId}` | `{ok:true}` |
| GET `/api/player/status` | Empty query | Existing `{available,deviceId,isPlaying,trackUri,reason}` |

Connection `status` is `ready|reconnect_required|premium_required|unavailable`. Ready requires both grants and `reason=null`; other statuses require a safe reason. Reconnect means at least one grant is unavailable. This is authorization readiness, not device/audible readiness. It is independent of the old `AccountSession.capabilities.playback` flag so connection setup remains accessible while that flag is false. Return `premium_required` only with actual evidence; absent/deprecated profile fields are not proof of subscription.

`connect` selects the next missing grant server-side (SDK first, then control), creates one purpose-bound attempt, and returns only a Spotify HTTPS authorization-code URL. If both grants are already usable, reject as a validation conflict rather than starting unsolicited consent. `returnTo=calibration` maps to `#/calibrate`; `review` maps to `#/review`. No caller-controlled redirect URI. The existing registered `https://api.sort.fm/api/auth/spotify/callback` is reused. After one consent, the UI reads connection readiness and may explicitly request the remaining grant; no automatic consent loop.

The existing `PlayRequestSchema={trackUri}` and legacy `/api/player/play` DTO are preserved for existing frontend callers. Their presence does not imply a working backend. New SDK code uses `playOnDevice` and the required-device route. Never silently target an active external device when the SDK device ID is missing.

Shared client methods: `playbackConnection()`, `connectPlayback({returnTo})`, `playbackToken(expectedOwnerId)`, `playOnDevice({trackUri,deviceId})`, `transferPlayback({deviceId})`, and `playerStatus()`. Token fetch uses credentials, POST `{}`, `cache:no-store`, `redirect:error`, and `referrerPolicy:no-referrer`. It rejects wrong-owner, expired, malformed or broadly scoped responses. Token errors use fixed local messages and allowlisted codes, discarding raw upstream envelopes, transport exceptions and causes. No POST retries are automatic.

## Playback behavior and errors

The server control grant calls the current [device-targeted start endpoint](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback), `PUT /v1/me/player/play?device_id=…` with exactly `{uris:[trackUri]}`. Transfer uses [PUT `/v1/me/player`](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback) with one `device_ids` entry and `play:false`. Spotify documents that `false` preserves current playback state; it does not guarantee silence. Transfer is therefore explicit user action, never initialization/prefetch. The two endpoints have no ordering guarantee: await outcomes and reconcile state instead of racing commands or blindly retrying an ambiguous write.

`{ok:true}` acknowledges a provider-accepted command, not audible success. [GET playback state](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback) uses the server control grant; 204 is no active playback. Device restriction/unavailability and unplayable tracks are honest errors. Browser SDK events/state confirm the actual track and playing state. SDK pause/resume, seek, and volume/mute operate on the local player; no additional control-token endpoint is needed. User gesture, autoplay, account/Premium and browser availability failures retain Open in Spotify.

Playback-specific `ErrorEnvelope.code` values are `PLAYBACK_PREMIUM_REQUIRED`, `PLAYBACK_RECONNECT_REQUIRED`, `PLAYBACK_UNAVAILABLE`, `PLAYBACK_SCOPE_REJECTED`, `PLAYBACK_DEVICE_UNAVAILABLE`, `PLAYBACK_DEVICE_RESTRICTED`, `PLAYBACK_TRACK_UNAVAILABLE`, `PLAYBACK_RATE_LIMITED`, and `PLAYBACK_OUTCOME_UNKNOWN`. Use 403 for Premium/scope/restricted, 401 for reconnect, 409 for unavailable device, 422 for unplayable track, 429 with Retry-After for rate limiting, and 503 for unavailable/unknown outcome. Unknown outcome is not automatically retryable. Common authentication, CSRF and validation errors retain the existing error envelope. Never forward provider bodies or bearer-bearing SDK errors.

## Migration 014 persistence port

`packages/contracts/src/playback-persistence.ts` exports the type-only `PlaybackStore`, `PlaybackOAuthAttempt`, `PlaybackGrant`, and refresh/session fence inputs. D owns migration **014**; migration 013 belongs to Musicae. Separate playback tables/grants preserve the original A1 primary account and OAuth rows. No library import, saved membership, review command, exposure, feedback revision, model label or C2 association changes during playback.

Every operation is atomic, owner-scoped and detached; transactions contain no provider I/O. Session-context methods verify that the initiating primary session still belongs to the owner, is unexpired, and references a non-revoked primary account. A1 rechecks the owner allowlist. `now` is server time. Credential fields and PKCE verifier are encrypted with owner/purpose-specific authenticated-encryption context; hashes, not bearer session cookies, identify sessions.

| Port method | Required atomic behavior |
|---|---|
| `createOAuth(attempt,now)` | Insert-only unique full-state hash across both playback purposes; live owner session; expiry; compare captured expected grant version |
| `consumeOAuth(context+stateHash+purpose+browserHash)` | Validate purpose/browser/session/expiry, mark single-use consumed, return immutable attempt; retain marker until expiry |
| `completeOAuth(context+stateHash+grant)` | Require consumed/not-completed attempt, live original session, matching owner/purpose, unexpired attempt and expected old version; publish only separate grant, mark completed |
| `getGrant(context+purpose)` | Live-session guarded separate-grant read; no primary-token fallback |
| `claimRefresh(fence+leaseUntil)` | Claim matching non-revoked version under absent/expired lease; bind lease to initiating session |
| `completeRefresh(fence+grant)` | Require same live session, unexpired lease and old version; publish validated non-revoked replacement with fresh version and cleared lease |
| `releaseRefresh(fence)` | Clear only the matching version/lease |
| `revokeGrant(key+expectedCredentialVersion+optional leaseId+now)` | Fence and clear only that grant; never invalidate newer consent, another purpose, or primary login |

Raw OAuth state is namespaced `playback-sdk.<43-character random base64url nonce>` or `playback-control.<nonce>`; hash the full string. Purpose must match the stored attempt. **Dispatch playback-prefixed callbacks before `AuthService.callback`**. Unknown/invalid/replayed playback state never falls through to primary login and never consumes primary OAuth state. Check the initiating session cookie and purpose-bound browser nonce. Consume before code exchange even on denial. Verify `/me` identity equals the original primary owner, then publish via the stored attempt/version fence. Reject account mismatch, expired/logout session or newer consent without replacing main credentials/sessions. Retain separate purpose-bound OAuth cookies so parallel playback/library flows cannot consume each other's nonce.

## Ownership and acceptance

- A1: auth-purpose dispatch, separate-grant encryption/refresh, profile identity checks, owner/CSRF routes, targeted provider controls, truthful errors and redacted logs. Add no broad token to a public serializer.
- D: migration 014 and the exact atomic port, including state uniqueness, session invalidation, consume/publish once, and refresh/version fences. Test rollback and reapplication.
- B2: both cleanup and calibration use one owner-bound SDK lifecycle. Keep the token only in a short-lived closure feeding `getOAuthToken`; never PlayerState, persistent storage, URLs, journals or telemetry. Discard token/late callbacks on logout, account change, teardown and expiry. Disconnect/unsubscribe/cancel safely. Do not infer ready/audible state from an HTTP acknowledgement. Seeking/muting uses SDK controls and truthful state.
- Integration: merge contracts, D and A1/B2 incrementally; run full suites and controlled transport tests; deploy readers/backend before enabling SDK UI. Live Premium OAuth/play/seek/mute remains a separate acceptance gate, never implied by unit tests.

Required integration cases: exact versus expanded scopes on initial and refresh grants; omitted refresh scopes retaining only an already-validated set; logout/session expiry during callback/token/refresh; foreign owner; library versus playback state routing/replay/collision; stale refresh versus newer consent; credential-free logs/errors; no-store/CORS/CSRF and anonymous rejection; required device target; no autoplay on page load; SDK late response after logout; acknowledgement without audible state; ambiguous POST/429 never automatically replayed; playback leaves cleanup/calibration/database feedback unchanged.

Local logout prevents future token issuance through that session and stops the local SDK. It cannot revoke an access token already delivered to the browser or promise immediate provider revocation. Treat it as usable until its real provider expiry and minimize retention accordingly.
