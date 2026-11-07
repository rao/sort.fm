# B2 P0 live frontend handoff

Branch: `b2-live-frontend`, based on accepted B1 foundation `fd5aba2`. Initial independently tested implementation: `58a6442`. All changes stay in `apps/web/**`; no shared contracts, backend, root configuration or dependency lock changes.

## Ready for integration

The default entry checks `/api/me`. Anonymous users see Connect Spotify and an explicit demo option. A Spotify session opens the connected import screen after OAuth callback. Connect navigates to the frozen `authStart` route; logout calls the frozen logout route. Browser credentials remain HttpOnly/server-owned. The browser receives only the public session DTO.

`?mode=demo#/library` deliberately creates the local demo client and does not construct a live session client. The existing `?scenario=empty|load-error|decision-error` fixtures also select isolated demo mode. All demo links preserve this explicit mode when starting a new session.

`ConnectedLibrary` starts sync by POST, polls status every 1.5 seconds only while pending/running, displays actual processed/total/failed counts, supports retry and resync, and opens review. Current library total and remaining are displayed independently. Review entry refreshes a previously loaded queue, including after another import.

Live review uses `createApiClient` for existing shared methods and a small validated adapter for the registry's sync/status/summary/logout routes absent from that client. Every request includes credentials. GETs deduplicate concurrent reads and retry a retryable API failure at most once. Requests have a 20-second timeout covering response body consumption. Mutations never retry automatically. `VITE_API_ORIGIN` optionally sets the API origin at build time; omitted uses same-origin `/api` (the existing Vite dev proxy targets port 3001). Production must provide its API origin or a same-origin proxy, with the configured credentialed CORS and same-site cookies.

## Review, persistence and recovery

- No live request calls `demoBootstrap`. Queue requests explicitly use `mode=spotify`. Synthetic IDs/results are rejected, and the current account is checked against the adapter's bound owner before each mutation.
- Archive/Unlike buttons are disabled for a read-only session. Drag/keyboard attempts open the connection dialog; the adapter independently checks capabilities before sending mutations. An unavailable backend route produces an explicit error, never simulated success.
- Every command is journaled before network submission in tab-scoped `sessionStorage`, keyed by account ID. The journal stores the request and original idempotency key, not Spotify tokens. Storage failure prevents submission. Reload restores a pending command without automatically replaying it. Closing the tab is outside this journal's durability guarantee; server history remains authoritative.
- Only validated `COMPLETE` advances a decision and only `UNDONE` confirms restoration. A completed response followed by a failed refresh remains completed, with new commands disabled until server data refresh succeeds.
- Every confirmed action and Undo fetches a new queue. Undo never reuses the original exposure for a new decision. New input remains locked through that read, and a failure leaves the lock intact until refresh.
- A2's `409 UNDO_PENDING` with `retryable:true` is supported: the original COMPLETE/active-label history remains unchanged while restoration is pending; explicit retries preserve the undo key. The original COMPLETE is never accepted as Undo success. This behavior has a regression test.
- Check saved outcome performs GET-only reconciliation. Identity-matching COMPLETE **or UNDONE** settles a pending decide; only UNDONE settles a pending undo. Recovery reads and mutation retries share a lock to prevent older snapshots overwriting newer confirmed state.
- Nonretryable errors pause the session. Authentication/permission failures keep a resumable journal for explicit retry after reconnect. Other terminal failures remain paused until the server supplies a settled outcome; there is no client-side discard or fabricated recovery. A future endpoint-specific stale-exposure recovery can be added once A2's rejection codes are stable.

History consumes persisted ReviewResult records. Metadata is reused only for tracks actually loaded in this tab; otherwise the UI shows “Saved Spotify decision,” its track ID, and Open in Spotify. Undo still targets the server decision ID. Refreshed queue data can supply the missing metadata after restoration.

Dashboard counts come from LibrarySummary. The review counter uses server queue `remaining`, not total minus historical reviewed. Empty fetched items with positive remaining display Refresh queue rather than completion. The inspector reads actual model version/counts/holdout mix/evaluation/audio status, polling visible history/dashboard/insights views every 15 seconds. Review exposures are not periodically replaced while a person considers a song. Missing metrics display unavailable, not zero training or a bounded-history label count. Open in Spotify works on mobile and desktop; missing artwork uses a neutral placeholder rather than demo art.

## Contract and scope limits

- Frozen queue/history requests cannot accept the returned nextCursor. New queue selection is obtained through fresh reads after settled decisions. History labels a bounded page honestly. True cursor pagination needs an integration-owned additive contract change.
- History has no TrackCard payload. A richer history DTO or track lookup route would improve older-history titles and artwork; none was invented.
- React Query is not installed. This increment uses a small in-flight read cache with bounded GET retry, preserving the root lock and ownership boundary. React Query adoption requires an approved dependency/lock update by integration.
- Metrics expose holdout class counts but no training-class mix, ablation series or telemetry time series. Only supplied aggregates are rendered; no invented charts or endpoints.
- Spotify Playback SDK, retraining controls and P1 telemetry/model-lab expansion remain deferred. This code does not implement OAuth, provider writes or ML services.

## Verification

The implementation was checked against the B1 foundation plus A1, without relying on later unmerged A2 endpoints. Locked install left dependencies unchanged; lint (21 source files), root typecheck, production build, root tests (**101 passed, 1 skipped, 0 failed; 702 assertions**, including **36 frontend tests**) and foundation HTTP smoke passed. There is an explicit A1 database integration test skip when no test database is configured. The build retains the existing two nonfatal Zod PURE-annotation warnings.

Frontend regression coverage includes all original B1 tests, live provenance/account isolation, credentialed route selection, journal failures and account partitioning, retry after reload, authorization recovery, lost responses already undone, GET-only reconciliation, concurrent recovery/retry locking, fresh exposures after Undo, confirmed-write/read-failure handling, unavailable metrics, read-only controls and UNDO_PENDING.

Independent read-only review found and prompted fixes for reconnect locking, stale review after import, misleading unavailable metrics, already-undone reconciliation and a recovery/retry race. These fixes have focused regression coverage.

Browser verification used the **production bundle with a controlled local HTTP fixture**, not an authenticated Spotify account. Verified import start/running/complete, actual arrow input and async locks, Archive→Undo, failed Unlike→reload→same-command Retry, persisted history reload/Undo with unknown metadata, model-version/count updates, anonymous session gating and reconnect navigation. Desktop 1440×900 and mobile 390×844 were inspected; mobile had no horizontal overflow. The existing B1 gesture and keyboard tests remain passing.

- [Connected import screenshot — HTTP fixture](screenshots/b2-import-http-fixture.jpg)
- [Mobile review screenshot — HTTP fixture](screenshots/b2-review-mobile-http-fixture.jpg)

To reproduce the browser fixture, build the web app, then run from the repository root:

```sh
SORTFM_TEST_FIXTURE=1 bun apps/web/scripts/fixture-preview.ts
```

It binds only `127.0.0.1:5182`, serves `apps/web/dist`, injects a permanent “HTTP TEST FIXTURE · NO SPOTIFY CONNECTION” label and uses synthetic in-memory HTTP responses. It never contacts Spotify or reads credentials. Test controls can reset state, fail/recover decisions, expire the session or supply changed model metrics. It is not part of the production bundle.

Real owner OAuth, a real library import, four real provider actions plus Undo, database-backed refresh and actual retrained-model UI updates are **not verified by this handoff**. Integration owns those checks after route wiring and owner consent. No real Spotify mutations were performed here.
