# Live backend startup

Run commands from the canonical `sort.fm` checkout. Root `.env` is ignored and server-only. Configure the exact Spotify owner ID in `SPOTIFY_ALLOWED_USER_IDS`, a registered callback matching `PUBLIC_API_ORIGIN/api/auth/spotify/callback`, the token/session keys, Tiger URL, and the ML shared secret. Provider credentials must never use `VITE_` names.

```sh
bun --env-file=.env packages/db/src/migrate.ts
bun run dev:ml
# Separate terminals:
bun run dev:api
bun run dev:web
```

The API deliberately runs without Bun watch mode: watch reloads discard background workers without draining their durable leases. After a verified backend update, send SIGTERM to the known API process, wait for its clean exit, then rerun `bun run dev:api`. The frontend retains Vite hot reload. Never clear an active lease merely to speed up a restart; crash recovery waits for the persisted lease expiry.

The API checks existing tables and migration010's membership revision without changing schema, creates D's `PostgresA1Store`, and registers auth/import, queue and durable review/Undo workers when configuration is valid. Review, import and feedback workers drain before the database closes. Missing dependencies keep the isolated demo available and live OAuth fails closed with `503 SPOTIFY_NOT_CONFIGURED`. Startup diagnostics print only fixed codes. Health capabilities describe initialized wiring, not a continuous database or provider readiness guarantee.

`dev:ml` passes the same root server environment to Python. Use one ML replica with durable `services/ml/artifacts` storage. The browser only communicates with the public API; no ML secret, Spotify token or SoundNet key is returned to it.

After owner consent, import with `POST /api/library/sync` from the authenticated frontend, then poll `/api/library/sync/status`. Confirm totals from `/api/library/summary`. Do not infer remaining count by subtracting retained review history from current Spotify totals.

SoundNet operates in its own process. Once five distinct artists have been imported, follow `packages/db/README.md`: smoke, inspect actual matching/results, approve the successful smoke, enqueue the owner's library, then run the worker. Missing or failed audio remains nullable and must never block the queue. No library item is automatically removed based on a prediction.

For a real transaction smoke, the owner selects the track in the UI. Verify archive insertion before unlike, confirmed saved status after the action, persisted result/feedback revision, and restoration plus feedback revocation after Undo. Controlled-provider tests do not count as real Spotify proof.

`bun run smoke:backend` verifies real Tiger → real local C1 through HTTP OAuth/import/queue, all four review actions and Undo with controlled Spotify responses. It creates a random disposable schema and temporary ML artifact directory, validates cold metadata scoring with no audio, checks immutable stored/explained predictions, archive-before-unlike, repeated command identity, membership restoration, durable action/Undo events and automatically acknowledged model revisions, checks public insights/analytics against the actual evaluation and library, then stops ML to verify an explicit insights error and queue fallback. It never contacts Spotify or writes fixture rows to the application schema. This is deliberately distinct from the owner-consented real-library acceptance flow.

When `ML_SERVICE_URL` and `ML_SERVICE_SHARED_SECRET` are configured, the queue calls C1. `METADATA_RIGHTS_BASIS` records the owner's reviewed authorization for metadata training; audio retains its own source provenance. Assembly uses the full current library before selection. ML failure or missing audio returns an explicit honest fallback and cannot stop import. Models remain untrained until actual persisted review feedback is delivered.

The installed mutation registrar enables `spotifyWrite` only for sessions with the required granted scopes. Initial OAuth now requests the broader 19 ordinary permissions requested by the owner; playback still remains unavailable until implemented. Provider callback metadata is ignored, while state, browser cookie, bounded scalar fields and PKCE remain validated. After a failed callback, start a fresh connection rather than reusing the expired callback URL.

Import passes capture a membership revision before fetching pages. Confirmed removals/restorations invalidate stale scans; unresolved destructive work blocks final publication. A retry starts a fresh pass, preserving history and original save dates. This prevents import from silently undoing confirmed review state. Apply migration010 before starting the updated API.

Authenticated `/api/ml/insights` and `/api/analytics/summary` expose actual C1 evaluation and D persistence counts. Each dependency read has a bounded wait. An ML outage returns validated stale model-run history with null numerical metrics only when a real stored run exists; otherwise it returns `503 ML_UNAVAILABLE`. No synthetic metrics or placeholder model runs are persisted.

Authenticated `POST /api/ml/retrain` uses the exact same repository-backed snapshot adapter as automatic feedback. Send an absent body or `{}` with the allowed Origin; identity, labels and revisions come only from the server. Repeated unchanged snapshots return the same fit result, and a newer empty snapshot after Undo removes prior labels. Manual requests do not acknowledge feedback jobs. An ambiguous timeout or transport failure requires a model refresh before another explicit request; never retry this POST automatically. The 45-second outer deadline does not extend the ML client's 10-second request deadline. See `apps/api/src/ml/RETRAIN.md` for error and concurrency semantics.

The backend smoke also exercises this installed route before labels, after all actions and after all Undo commands. It verifies real fit metrics, repeated response identity, unchanged persisted snapshots/outbox revisions, immutable exposure explanations, owner/CSRF/input boundaries and explicit ML outage errors. All test data remains in its disposable schema and temporary ML service.
