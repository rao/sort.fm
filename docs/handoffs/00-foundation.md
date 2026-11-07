# Task 00 handoff — foundation and shared contracts

STATUS: **PASS for local foundation implementation and verification.** Contract acknowledgment by the external A/B/C/D sessions is the next coordination step. The complete product's P0 acceptance gates are not yet satisfied.

Implementation root: `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm`.
Branch: `foundation`. Original supplied specs remain untouched in the parent directory.

## Scope implemented

Bun-workspace TypeScript scaffolding, a real Fastify HTTP API, a minimal Vite/React consumer, a uv/FastAPI service, canonical Zod contracts/types, internal ML route contracts, exact DB inputs, deterministic fictional fixtures, environment examples, development CORS, build/typecheck/test scripts and real HTTP smoke checks. OAuth, persisted review workflows, trained ML, polished UI, provider ingestion and deployment remain with their assigned later briefs.

## Files changed

- Root: `package.json`, `bun.lock`, `tsconfig.json`, `.gitignore`, `.env.example`, `AGENTS.md`, `README.md`.
- Contracts: `packages/contracts/package.json`; `src/index.ts`, `schemas.ts`, `features.ts`, `db.ts`, `routes.ts`, `fixtures.ts`, `client.ts`; `test/contracts.test.ts`; generated `contracts.schema.json`, `demo-bootstrap.json`.
- API: `apps/api/package.json`; `src/app.ts`, `config.ts`, `index.ts`; `test/app.test.ts`.
- Web: `apps/web/package.json`, `index.html`, `vite.config.ts`; `src/main.tsx`, `App.tsx`, `App.test.tsx`, `styles.css`, `vite-env.d.ts`.
- Python: `services/ml/.python-version`, `pyproject.toml`, `uv.lock`, `README.md`; `src/sortfm_ml/__init__.py`, `app.py`; `tests/test_app.py`.
- DB placeholder: `packages/db/package.json`, `src/index.ts`.
- Scripts: `dev.ts`, `export-contracts.ts`, `seed-demo.ts`, `smoke-foundation.ts`, `smoke-ml.ts`.
- Documentation: this handoff, `docs/contracts.md`, `docs/assumptions.md`, `docs/superpowers/plans/2026-11-07-foundation.md`.

## API/schema impact

Contract `1.0.0`, feature version `sortfm.features.v1`. Import schemas/types from `@sortfm/contracts`. `PUBLIC_ROUTES` and `INTERNAL_ROUTES` define method/path/body/query/response contracts; all 18 public routes are registered, with unfinished features returning explicit 501s. ML's five private capability routes enforce bearer authentication and return explicit 501 after valid auth.

Real working routes: API `/api/health`, `/api/me` (anonymous), `/api/demo/bootstrap`, `/api/queue?mode=demo`; ML `/health`. The demo page calls the API through `createApiClient`, displays 12 fictional tracks and actual absent evaluation state, and can reload/recover its queue. Demo bootstrap does not create a real session. No route contacts Spotify or SoundNet or writes to a database in this stage.

Example read:

```sh
curl 'http://127.0.0.1:3001/api/queue?mode=demo&limit=2&policy=balanced'
```

Example future review payload (foundation returns `501 NOT_IMPLEMENTED`, no writes):

```json
{
  "trackId": "demo:001",
  "action": "ARCHIVE",
  "exposureId": "00000000-0000-4000-8000-000000000001",
  "idempotencyKey": "00000000-0000-4000-8000-000000000002"
}
```

Read `docs/contracts.md` before implementing actions. Undo has its own key and DB command input. Exposures persist the complete original prediction and features. Model metrics reject impossible counts and fabricated values when unavailable. Strong labels activate only after completed decisions; pending workflows cannot advertise Undo. Schema validation is defense in depth; A must still enforce ownership, atomic state transitions, idempotency and remote reconciliation in the actual handlers.

## Tests run and results

Verified November 7, 2026:

```text
bun install --frozen-lockfile                 exit 0 (fresh temporary checkout)
bun run typecheck                            exit 0
bun run test                                 23 pass, 0 fail; 105 assertions
bun run build                                exit 0; web and API bundles produced
bun run test:ml                               54 passed
bun run smoke                                PASS foundation HTTP smoke
bun run smoke:ml                             PASS ML HTTP smoke
bun run contracts:export                     60 schemas + routes exported
uv sync --locked / uv lock --check            pass
git diff --check                             pass
```

A completely fresh temporary copy (no node_modules, venv, build output or .env) passed locked Bun installation, typecheck, tests and build. The temporary directory was removed afterward. Production bundling emits two nonfatal upstream Zod comment-annotation warnings; no build errors.

## Smoke proof

- Real HTTP API: health capabilities, anonymous session, synthetic bootstrap/queue, null model metrics, request validation, refused origin, credentialed CORS preflight, explicit unfinished mutation response.
- Real HTTP ML: starts Uvicorn; validates health with the shared exported contract; absent/wrong tokens rejected on all five routes; correct token returns explicit unfinished behavior. No provider secrets used.
- Real browser at `http://127.0.0.1:5173`: 12 synthetic tracks rendered; queue reload works; stopping API shows an error while retaining tracks; restarting API and pressing Load demo queue clears the error and reloads. Model status says Evaluation unavailable and untrained-v0.
- Dev supervisor shutdown: stopping the API shuts down Vite too; no listeners remain on 3001/5173 after testing.

Regression tests caught then verified fixes for pending Undo, unconfirmed restoration, missing active labels, stale exposure snapshots, nonexistent undo persistence DTO, impossible metric counts, and Python 404/405/validation error-envelope mismatches. An independent reviewer surfaced the undo/exposure gaps; its final review was interrupted by the account's agent usage limit. The integration lead completed the fixes and fresh verification locally; this is not a completed independent security audit.

## Blockers, risks and next dependencies

- **Next:** distribute A1, B1, C1 and D with the master spec plus `docs/contracts.md` and generated artifacts. Each should acknowledge the DTOs or propose amendments before independently changing them.
- A1 needs real server credentials, authorized account IDs, registered redirects and D's persistence adapter. No provider credentials or remote mutations were tested.
- A2 must implement durable decision/undo state, real Spotify reconciliation and demo-session isolation. Current 501s are intentional boundaries.
- C1 must implement the real Python feature/model pipeline, consume fixtures/schemas, persist artifacts and demonstrate score changes. No trained-model claims are made.
- D must implement schema/migrations and feature ingestion. No PostgreSQL/Timescale connection or SoundNet smoke is verified. Keep the specified provider/Timescale fallbacks.
- B1 replaces the intentionally plain foundation consumer with the requested interface. It must retain honest metrics and confirmed mutation/error states.
- Deployment to Vercel/Railway/Tiger Data, HTTPS/CORS/cookies, real import/archive/undo, and the end-to-end production gates belong to later integration; none is claimed complete.
- Resolve the Web Playback SDK browser-token/server-only-token tension before P1; P0 can use open-in-Spotify.

## Integration instructions

Use the foundation commit as the common starting point for short-lived worktrees/branches. No remote push or deployment has been performed. Keep root config, shared contracts and root scripts under the integration lead. A owns API module wiring after handoff; B owns web; C owns Python; D owns DB and `apps/api/src/jobs/soundnet`. Avoid concurrent edits to the same directory by advancing follow-on briefs within each session sequentially.

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run test`, and the relevant smoke checks after integration. `bun run dev` starts local web/API, and `bun run dev:ml` starts the separate ML service. See README for setup and environment details.
