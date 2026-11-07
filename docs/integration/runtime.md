# Live backend startup

Run commands from the canonical `sort.fm` checkout. Root `.env` is ignored and server-only. Configure the exact Spotify owner ID in `SPOTIFY_ALLOWED_USER_IDS`, a registered callback matching `PUBLIC_API_ORIGIN/api/auth/spotify/callback`, the token/session keys, Tiger URL, and the ML shared secret. Provider credentials must never use `VITE_` names.

```sh
bun --env-file=.env packages/db/src/migrate.ts
bun run dev:ml
# Separate terminals:
bun run dev:api
bun run dev:web
```

The API checks existing tables without changing schema, creates D's `PostgresA1Store`, and registers A1 auth/import when configuration is valid. It closes the importer before the database. Missing dependencies keep the isolated demo available and live OAuth fails closed with `503 SPOTIFY_NOT_CONFIGURED`. Startup diagnostics print only fixed codes. Health capabilities describe initialized wiring, not a continuous database or provider readiness guarantee.

`dev:ml` passes the same root server environment to Python. Use one ML replica with durable `services/ml/artifacts` storage. The browser only communicates with the public API; no ML secret, Spotify token or SoundNet key is returned to it.

After owner consent, import with `POST /api/library/sync` from the authenticated frontend, then poll `/api/library/sync/status`. Confirm totals from `/api/library/summary`. Do not infer remaining count by subtracting retained review history from current Spotify totals.

SoundNet operates in its own process. Once five distinct artists have been imported, follow `packages/db/README.md`: smoke, inspect actual matching/results, approve the successful smoke, enqueue the owner's library, then run the worker. Missing or failed audio remains nullable and must never block the queue. No library item is automatically removed based on a prediction.

For a real transaction smoke, the owner selects the track in the UI. Verify archive insertion before unlike, confirmed saved status after the action, persisted result/feedback revision, and restoration plus feedback revocation after Undo. Controlled-provider tests do not count as real Spotify proof.

`bun run smoke:backend` verifies the real Tiger → real local C1 integration through HTTP OAuth/import/queue with controlled Spotify responses. It creates a random disposable schema and temporary ML artifact directory, validates cold metadata scoring with no audio, checks immutable stored/explained predictions, and stops ML to verify queue fallback. It never contacts Spotify or writes fixture rows to the application schema. This is deliberately distinct from the owner-consented real-library acceptance flow.

When `ML_SERVICE_URL` and `ML_SERVICE_SHARED_SECRET` are configured, the queue calls C1. `METADATA_RIGHTS_BASIS` records the owner's reviewed authorization for metadata training; audio retains its own source provenance. Assembly uses the full current library before selection. ML failure or missing audio returns an explicit honest fallback and cannot stop import. Models remain untrained until actual persisted review feedback is delivered.
