# A1: Spotify authentication and library ingestion

A1 owns `auth/**`, `spotify/**`, `library/**` and the minimal `/api/me` fallback registration change in `../app.ts`. No web, ML, shared-schema, migration, review, playlist, playback or SoundNet implementation is included.

## Integration

```ts
import {connectDatabase, PostgresA1Store} from '@sortfm/db';
import {buildApp} from '../app';
import {loadSpotifyConfig} from './config';
import {createSpotifyModule} from './module';

const config = loadSpotifyConfig();
// After integrating D and applying its migrations:
const db = connectDatabase();
const spotify = createSpotifyModule({config, store: new PostgresA1Store(db)});
const app = await buildApp({config, registerRoutes: spotify.registerRoutes});
await app.listen({port: config.port, host: config.host});
```

The database imports above are D’s published adapter API; merge D before enabling this production bootstrap. Close the database after `await app.close()` during shutdown. There is deliberately no default or in-memory production store. The existing `src/index.ts` stays on foundation behavior until the integration lead wires D's adapter. `createSpotifyModule` creates one HTTP client/token service/importer per process. Fastify startup recovers persisted pending/running/retryable failed jobs; shutdown drains active work and releases checkpoints. The recovery timer runs every 30 seconds. Reuse `spotify.auth.session(cookieToken)` / `assertOwner(account)` in later API work; never accept a user ID from a browser. A2 must add write scopes and its own confirmed mutation workflow before changing `spotifyWrite` capability.

The module provides:

- `GET /api/auth/spotify/start`: 302 to Spotify, randomized state plus S256 PKCE, ten-minute HttpOnly browser-binding cookie; verifier encrypted server-side.
- `GET /api/auth/spotify/callback`: single-use state consumption, code exchange, `/me` owner allowlist, encrypted access/refresh tokens, hashed 30-day opaque session, 302 to fixed frontend origin. No open redirects.
- `POST /api/auth/logout`: revokes this session and clears its cookie. Does not delete imported data or revoke Spotify consent.
- `GET /api/me`: public profile/capabilities only; anonymous when no valid session. No provider call or import.
- `POST /api/library/sync`: requires owner session and exact frontend/API `Origin`; accepts no body or `{}`. Returns 202 and current progress. Coalesces active jobs; failed jobs resume after persisted cooldown. A subsequent POST after completion starts a new scan with idempotent track upserts.
- `GET /api/library/sync/status`: owner-only checkpoint; does not launch work.
- `GET /api/library/summary`: owner-only database counts; does not launch work.

Use `credentials: 'include'` for browser fetches. POST callers, including manual API clients, must supply the configured `Origin`. Query/body user IDs, unexpected fields, foreign origins and cross-site POSTs are rejected. Health capability advertisement and production bootstrap are integration-owned and must reflect the installed D adapter; foundation health remains conservative until wired.

## Configuration

Existing env names only:

- `SPOTIFY_CLIENT_ID`: Spotify application ID. PKCE does not require or read `SPOTIFY_CLIENT_SECRET`.
- `SPOTIFY_ALLOWED_USER_IDS`: comma-separated Spotify profile IDs, server-only, nonempty.
- `TOKEN_ENCRYPTION_KEY`: canonical base64 of 32 random bytes (AES-256-GCM). Persist this secret across deploys. Changing it without re-encrypting records requires reauthorization.
- `SESSION_SECRET`: at least 32 characters of random secret material; HMAC-hashes session identifiers. Persist across replicas/deploys. Rotation invalidates current sessions.
- `PUBLIC_WEB_ORIGIN`, `PUBLIC_API_ORIGIN`, `SPOTIFY_REDIRECT_URI`: exact origins and callback. Development defaults use `127.0.0.1`. HTTP is allowed only for loopback IPs outside production; production requires HTTPS.
- `NODE_ENV`, `HOST`, `PORT`: existing API config.

Register both `http://127.0.0.1:3001/api/auth/spotify/callback` and `https://api.sort.fm/api/auth/spotify/callback` in Spotify. Deploy frontend/API on the same site (`sort.fm` / `api.sort.fm`) so SameSite=Lax credentials work. HTTPS uses host-only `__Host-` cookies with Secure, HttpOnly, Path=/; no Domain attribute. Local HTTP uses unprefixed host-only cookies. Consent requests `user-library-read`, `user-read-private`, `user-read-recently-played`. Missing optional recent-play permission never blocks the import. Access/refresh tokens stay server-side and are encrypted with owner/purpose-bound authenticated encryption. Session responses cannot contain encrypted credentials either.

## D persistence contract

`store.ts` re-exports the integration-owned `@sortfm/contracts` persistence types. All transaction callbacks must be atomic and serializable across processes; account/job lease reads and writes must lock or use equivalent conditional updates. A callback throwing must roll back tracks, observations and job cursor together. Detached return values prevent out-of-transaction mutation. A1 performs no HTTP requests inside DB transactions. Retry only safe serialization failures with the entire transaction; ambiguous commit failures are resolved by rereading the durable checkpoint.

Required uniqueness/indexes:

| Record | Key / requirements |
|---|---|
| Account | `user.id`; encrypted token envelopes, scopes, expiry, credential version and refresh lease |
| Session | unique HMAC hash; indexed user and expiry; no raw cookie token |
| OAuth attempt | unique state hash; browser hash + encrypted verifier + expiry; atomic consume |
| Import job | one current job per user; UUID job ID, progress, lease, retry deadline, monotonic pass, bounded-restart counter, seen IDs, rejected/duplicate counts, first-page hash |
| Saved track | `(userId, trackId)`; preserve earliest **stored** originalAddedAt and existing review state; update metadata; consume canonical SavedTrackInput |
| Raw observation | `(userId, jobId, pass, offset)`; raw original payload including local/null entries, reason and observed time; retain earlier scans |
| Confirmed membership | user-scoped latest successful job/pass, known unique track IDs, provider source total and observation time; replace atomically only after successful reconciliation |
| Taste context | user-scoped available recent events, fetch time and optional sanitized failure; never label as complete history |

D should prune expired OAuth attempts and sessions; retain required import/snapshot history under the project's retention policy. `resumableUserIds()` returns pending/running/retryable failed job owners. A1 rechecks retry deadlines, leases and owner credentials. TestStore is only a transaction double; its tests prove application behavior under that transaction contract, not PostgreSQL isolation or durability. D must run its adapter transaction tests and restart/concurrent-worker tests against the actual database.

## Import semantics and limits

Pages use `GET /me/tracks?limit=50&offset=N`. Offsets count raw source slots, not unique valid tracks; each commit stores normalized rows, raw observations and checkpoint atomically. `processed` counts unique Spotify IDs in the current scan, `failed` counts rows that cannot become shared TrackCards, `total` is Spotify's reported source-slot total. Thus 100 source slots with 2 local tracks yields processed=98, failed=2, total=100. Null/local/malformed entries remain in observations; unavailable Spotify tracks with valid IDs remain cards, with `isPlayable=false` where known. Missing artwork is null. No fake Spotify IDs, popularity, ML labels or play counts are generated.

Successful completion calls `completeImportMembership` inside the same job/pass/lease-fenced transaction as the complete checkpoint. Partial scans leave the previous membership intact; a successful empty scan clears it. `LibrarySummary.total` is the latest confirmed Spotify source total, including rejected source slots; `remaining` is known current membership eligible for review. Review/action counters describe retained effective completed decisions, so total need not equal reviewed + remaining. A2 must adjust membership/counts only after confirmed, idempotent Spotify mutations.

Snapshot/original dates and metadata survive resync; current review status must not be reset to `saved`. Legacy relinking responses use `linked_from.id` as the saved identity when available and retain the returned playable identity in raw metadata. No removed 2026 field is required. The raw `added_at` also preserves newly observed save dates when an old snapshot has an earlier originalAddedAt.

A stable 2,700-track library takes 54 data pages plus one head verification request. Resume rechecks the first page. A changed head, changing total, duplicate IDs or count mismatch triggers up to two rescans, then an explicit retryable failure. Prior-pass observations remain retained. Spotify offers offset pagination, not a server-side immutable snapshot: same-count edits outside the checked head can evade detection. Do not claim point-in-time snapshot isolation while a user edits Spotify concurrently. Re-run after editing stops.

HTTP errors are sanitized. Reads retry 429/5xx/network failures with bounded backoff and jitter; Retry-After seconds and dates are respected. Delays over 30 seconds return a retry deadline instead of sleeping in an HTTP handler; import persists it across restart. Refresh handles rotated or omitted refresh tokens, invalid_grant revocation, proactive expiry refresh, and one refresh retry for a rejected read. Refresh leases fence competing replicas and stale revocation. Import workers renew active, unexpired five-minute leases every 30 seconds; an expired or replaced lease cannot be resurrected. Refresh credentials cannot be atomically rotated across Spotify and our DB: a crash after provider rotation but before DB commit may require owner reauthorization.

Recent context contains at most the latest available 50 events, deduplicated by track/time. It is a weak observational signal, not a complete month, lifetime history or a KEEP label. The importer makes no Spotify library/playlist mutation calls.

## Verification

Run from repository root:

```sh
bun test apps/api/src/auth apps/api/src/spotify apps/api/src/library
bun run typecheck
bun run test
bun run build
bun run smoke
```

The default A1 suite uses controlled Spotify responses and a transactional test-only store. One test exercises the full A1 HTTP flow through a real loopback socket. `database.integration.test.ts` is separately opt-in via `TEST_DATABASE_URL` and `A1_DATABASE_ADAPTER_ROOT` (path to a checkout containing D's adapter/migrations). It creates and removes only a unique `test_a1_flow_*` schema. Never supply credentials on the command line or print environment values.

Verified against real Tiger Data using D's working adapter on November 7, 2026: encrypted OAuth persistence, actual SQL rollback after an injected failed page, restart/resume at the committed offset, session lookup through reconstructed services, simultaneous refresh coalescing, successful resync membership replacement, retained original snapshots/timestamps, and persisted logout. This test passed 13 assertions in 8.1 seconds; Spotify responses were synthetic. D fixed a real PostgreSQL serialization retry issue caught by this integration test. Final integration must include D's published version with that fix.

Live owner OAuth, real ~2,700-song import, real provider refresh and production HTTPS/cookies remain unverified. The integration lead configured the server encryption/session secrets; the canonical environment still lacks `SPOTIFY_ALLOWED_USER_IDS`. Supply the exact owner Spotify ID, confirm the registered redirect, then obtain owner consent. Configuration remains fail-closed until then. No real Spotify import was attempted. The frozen current public DTOs are unchanged; shared persistence additions were approved and published by the integration lead.

Official references checked November 7, 2026: [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), [refresh](https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens), [saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks), [2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
