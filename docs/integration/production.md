# Production rollout

Production is running on Vercel at `https://sort.fm`, Railway at `https://api.sort.fm`, a private single-worker Railway ML service, and the existing Tiger Data database. Railway project `sort-fm` (`5ff2fbde-db08-4a51-b3d3-70dffe40cb92`) is in Krom’s Projects. The first API deployment `46cc5c19-46b7-4ec6-88f3-0b03eea23999` and ML deployment `371879b1-3f78-45b0-810f-e0a9be03d50a` use the verified `e1a1229` runtime. The ML volume is mounted at `/data/ml`. Vercel’s pinned npm/Bun bootstrap passed its actual Linux build at `fd154b0`; later foundation pushes deploy the frontend automatically, while Railway uploads remain explicit.

The local API is stopped. Before cloud API startup, a consistent private database backup was restored and checked in an isolated PostgreSQL fallback, and all nine ML artifact files were checksum-verified after private transfer. The actual owner’s evaluation and immutable Thriller explanation match exactly across local and cloud ML. Revision, feedback target and acknowledgement are all 2; labels and trained examples are zero after the verified Undo. Keep only this cloud API/ML pair consuming the shared production outbox.

Cloudflare hosts the authoritative DNS. Both API routing and ownership records are installed, Railway reports propagated DNS and valid TLS, and the user confirmed the production Spotify callback is registered. The anonymous production smoke passed with public DNS resolution and normal hostname/TLS validation; the local campus resolver still caches old Namecheap records. This is not proof of local DNS propagation. Authenticated API-to-private-ML evaluation, database state, the OAuth start redirect and secure host-only OAuth cookie attributes passed from the API container. The campus resolver has since propagated; the current anonymous smoke passes without DNS overrides. A real production browser OAuth return/session/library check is still pending with the user.

Calibration release `7860101` is now live: ML deployment `7dbe47c2-f944-42c5-a79e-8aefd8b75b09` and API deployment `b52e26e9-b4c8-4e43-af07-7ec53306c480`. Migration012 was applied explicitly and its second run was a no-op. Existing library/feedback/credentials and exposure payloads were unchanged. A fresh cloud artifact backup and post-restart checksum/evaluation/explanation comparison passed. The owner can label without Spotify mutation at `https://sort.fm/#/calibrate`; actual human-label training and browser OAuth acceptance remain to be observed.

## Build boundaries

Use the repository root as Docker build context so the API can resolve the shared workspace. Keep Vercel's project root at `apps/web` and enable inclusion of source files outside that root. `apps/web/vercel.json` runs install/build from the repository root and serves only the web `dist`; `VITE_API_ORIGIN=https://api.sort.fm` is its required public API setting. Never give Vercel the root server `.env`, Spotify credentials, database URL, ML secret or SoundNet key. Upload exclusions and container ignore rules must exclude local environments, private ML artifacts, backups and Git metadata.

Railway API and ML are separate services using `deploy/api/Dockerfile` and `deploy/ml/Dockerfile`. Apply the current dashboard/API settings in `deploy/README.md`; new services do not use the retired legacy config-file mechanism. Set API `NODE_ENV=production`, `HOST=0.0.0.0`, `PUBLIC_WEB_ORIGIN=https://sort.fm`, `PUBLIC_API_ORIGIN=https://api.sort.fm`, `DEMO_MODE_ENABLED=true` and the provider-registered `SPOTIFY_REDIRECT_URI=https://api.sort.fm/api/auth/spotify/callback`. The process honors Railway's `PORT`. Other server variables retain their names from `.env.example`; enter secrets through private service variables, never committed files, build arguments or `VITE_` names.

ML must have one process/replica with durable `ML_ARTIFACT_DIR=/data/ml` and a persistent volume at that path. Use its private Railway address and explicit listening port for API `ML_SERVICE_URL`; both services receive the same private `ML_SERVICE_SHARED_SECRET`. Set API `ML_ALLOW_RAILWAY_PRIVATE_HTTP=true` only inside Railway private networking; missing or any other value leaves the narrow HTTP exception disabled. Do not create a public ML domain. Railway private networking must resolve and reach the actual bound address. Inspect `/health` from the API environment, then authenticate a read-only evaluation request without printing the secret. Liveness checks do not prove database or provider readiness.

## State and cutover

Production must not race a local API using the same application schema and a different ML artifact directory. The feedback outbox acknowledges one consumer's fit; running independent local/production models against that outbox can leave one model stale. Drain the local API before starting the production API for this owner. Keep the local frontend available as a fallback, but use only one active backend/model pair for the owner's shared state.

Before cutover, securely snapshot the database and copy/checksum the private ML artifact directory outside Git. Preserve the existing token-encryption key if reusing encrypted accounts in Tiger. Transfer artifacts privately to the ML volume, with no build-context inclusion. Preserve existing owner/exposure artifacts; a fresh model does not reproduce historical `/explain` snapshots. Validate model version, counts and known immutable exposure explanations after transfer. Keep the backup until production rollback has been tested.

Migrations remain an explicit operator step using `bun packages/db/src/migrate.ts` with the target service's private database settings. Confirm migration012 is present, a second run is a no-op, and the existing telemetry hypertable is retained where supported. Do not run destructive schema resets or migrations automatically on every service startup. Configure the exact production Spotify callback in the developer dashboard before the owner's new consent flow.

## Acceptance

After DNS/TLS and deployment, run from the repository root:

```sh
bun scripts/smoke-production.ts
```

This is an anonymous check of the frontend, initialized API wiring, synthetic demo isolation, account/ML guards and cross-origin credentials. It never supplies an owner cookie or sends a real cleanup command. Local verification is explicit:

```sh
bun scripts/smoke-production.ts --web http://127.0.0.1:5173 --api http://127.0.0.1:3001 --allow-local-http
```

Then use the real production browser to verify secure HttpOnly session cookies, exact credentialed CORS, allowlisted OAuth, import/summary, responsive review controls, honest model counts/version and Open in Spotify. A user-selected song must complete Archive before Unlike, then Undo must restore its liked state. Separately verify direct Unlike/Undo and Keep/Skip feedback semantics. Confirm persisted revisions and automatic ML delivery; do not use controlled transport tests as evidence of Spotify writes. After enough real labels exist, show changed predictions and adaptive ordering, then persistence through a graceful API/ML restart. Keep insufficient metrics null.

Rehearse the anonymous judge demo without access to the owner's library. Record deployed URLs/commit, each actual acceptance result, and unresolved gates in `status.md`. Native playback, bulk SoundNet and C2 policy activation remain optional until P0 is complete.

References: [Railway monorepos](https://docs.railway.com/deployments/monorepo), [start commands](https://docs.railway.com/deployments/start-command), [health checks](https://docs.railway.com/deployments/healthchecks), [Vercel monorepos](https://vercel.com/docs/monorepos) and [build configuration](https://vercel.com/docs/builds/configure-a-build).
