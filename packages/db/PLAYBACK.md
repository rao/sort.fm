# Playback persistence handoff

`PostgresPlaybackStore` implements the frozen server-only `PlaybackStore` port. Migration `014_playback.sql` adds `playback_grants` and `playback_oauth_attempts`; it does not alter primary credentials, library membership, calibration, feedback, or provider caches. This branch is based on sanitized foundation `9965249`. Integration owns runtime activation and production migration; neither is performed by this workstream.

```ts
import {connectDatabase, PostgresPlaybackStore} from '@sortfm/db';
const playbackStore = new PostgresPlaybackStore(connectDatabase());
```

## Integration and readiness

A1 supplies namespaced full-state hashes, server-derived session hashes, owner/purpose-authenticated encrypted envelopes, exact provider scopes, allowlist/profile checks, and provider calls. The adapter validates envelope shape, not cryptographic authenticity. It never handles plaintext bearer tokens, implements OAuth, or calls Spotify. Keep `DATABASE_URL` and encryption keys server-side.

Run both readiness probes through `Database.transaction` so the configured schema is used:

```sql
SELECT user_id,purpose,payload,updated_at FROM playback_grants LIMIT 0;
SELECT state_hash,user_id,purpose,payload,expires_at,consumed_at,completed_at
FROM playback_oauth_attempts LIMIT 0;
```

If either table is absent, disable playback only. Library, calibration, reviews, ML, and enrichment must remain available. Root owns that optional readiness wiring. A1's companion error-mapping fix is `d8d6c4ea9fb9bb6a14ff72d5f556df4be76f19c2`: preserve `AUTHENTICATION_REQUIRED` from a failed consume guard rather than replacing it with `OAUTH_STATE_INVALID`.

The integration lead can apply the repository migration runner after merging and checking readiness/deployment ordering:

```sh
bun --env-file=.env packages/db/src/migrate.ts
```

This command applies all pending migrations, not just 014. It has **not** been run against the application schema for this handoff. Migration015 is reserved for a separate workstream. Do not modify an applied migration checksum or drop live playback tables as a rollback shortcut.

## Atomic behavior and errors

Every session-context operation locks the owner, primary session, and primary account inside a serializable transaction. Deleted/expired sessions and revoked accounts fail closed. Time checks add elapsed monotonic time, including lock waits and definite rollback retries, to the caller's trusted server `now`. Transactions use 2-second lock and 5-second statement timeouts. Only PostgreSQL serialization/deadlock rollbacks retry, at most three times with bounded jitter. Ambiguous commit/network failures do not retry automatically.

State insertion is unique across playback purposes; existing primary-library state hashes are rejected. Consume checks owner, purpose, browser hash, initiating session and expiry before marking the state. Publication requires consumption and succeeds once, guarded by the captured credential version. Consumed/completed markers are retained; no cleanup worker is installed. Refresh claims bind the lease to the initiating session; stale versions, expired completions and replaced leases cannot publish or clear newer work. Revocation clears only the fenced purpose's sealed credentials and lease and deliberately needs no live session, allowing cleanup after logout.

| Result | Meaning |
|---|---|
| `AUTHENTICATION_REQUIRED` | Primary session/account is unavailable, expired, revoked, or belongs to another owner |
| `STATE_CONFLICT` | OAuth hash collision or captured version changed before insertion |
| `OAUTH_STATE_INVALID` | Invalid/replayed/expired consume evidence |
| `PLAYBACK_SCOPE_REJECTED` | Missing, extra, or duplicate purpose scopes |
| `ENCRYPTED_CREDENTIAL_REQUIRED` | Credential/verifier lacks the sealed envelope shape |
| `INVALID_PLAYBACK_INPUT` | Invalid internal input or persisted grant |
| `false` / `null` | Expected conditional-write miss after session validation, as defined by the frozen port |

Errors are fixed `PersistenceError` codes with no credential-bearing payload. Structural extra properties on internal `revokeGrant` input are stripped because A1 passes a spread refresh fence; public request validation remains strict. Returned records are detached. Primary tokens are never a fallback. An expired playback access grant can be read by a live session so A1 can refresh it; the API must validate expiry before issuance.

## Verification

Focused tests use generated accounts/ciphertext and random disposable `test_playback_*` schemas; they never call OAuth or provider transports:

```sh
TEST_DATABASE_URL=postgres://localhost/test_database bun test \
  packages/db/test/playback-store.test.ts \
  packages/db/test/playback-migration.test.ts
bun run typecheck
bun run build
```

Verified on 2026-11-07: full Bun suite with disposable local PostgreSQL **719 pass, 12 skip, 0 fail** (4,419 assertions); focused playback tests **10 pass, 0 fail** (97 assertions) on both local PostgreSQL and actual Tiger Data. Typecheck and production web/API build passed. Skipped cases require separate opt-in slow/provider/C1 integration configurations. No real OAuth or audible-playback acceptance is claimed.

The migration test creates legacy001–013, hashes all existing base-table contents, rolls back 014, applies it once, verifies reapplication is a no-op, exercises grant operations, and verifies prior contents remain identical. Store tests cover consume/publish once, invalid evidence, cross-owner/purpose/session fences, consent replacement, refresh contention/expiry, logout/re-login, rollback, corrupted scopes, and expiry during owner-lock contention.

Independent review found no blocking defects. Deferred minor: logout/re-login fencing is tested sequentially and expiry is tested under lock contention; a direct overlapping primary logout/re-login versus playback-completion test would strengthen coverage of differing lock orders. Live Premium consent, SDK token issuance, and audible playback are integration acceptance gates, not established by these persistence tests.
