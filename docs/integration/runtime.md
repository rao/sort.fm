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
