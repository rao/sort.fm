# sort.fm

Your music taste evolved. Your Liked Songs didn't.

This repository currently implements **Task 00: foundation and shared contracts**. The web page consumes a real Fastify API with fictional demo fixtures. Spotify login, durable decisions, personalization and deployment are subsequent handoffs; the foundation does not claim these work. No external credentials are needed for the demo preview.

## Run locally

Prerequisites: Bun 1.4.3+, uv, Python 3.11+ (uv can provision Python).

```sh
cd /Users/ramin/Desktop/v2code/ubhacking2026/sort.fm
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Open <http://127.0.0.1:5173>. The frontend proxies `/api` to `127.0.0.1:3001`. Start ML separately with `bun run dev:ml`. The ML health route works without a key; internal routes require `ML_SERVICE_SHARED_SECRET` in the process environment. Set it in your local environment or launch uvicorn with `--env-file` only after installing its optional dotenv support. The foundation API does not yet call ML. `bun run dev` starts only API and web, and shuts both down together.

Production targets remain Vercel `https://sort.fm`, Railway `https://api.sort.fm`, private Railway ML, and Tiger Data PostgreSQL. These services have **not** been provisioned or deployed by Task 00. Build the frontend with public `VITE_API_ORIGIN=https://api.sort.fm`; all secrets must remain in server environments. `PUBLIC_*` variables describe server CORS/origins, not browser-bundled configuration.

## Verify

```sh
bun run typecheck
bun run test
bun run build
bun run test:ml
bun run smoke
bun run smoke:ml
bun run contracts:export
bun run seed:demo > /tmp/sort-fm-demo.json
```

Both smoke scripts start temporary loopback services and shut them down. They do not contact Spotify or SoundNet. API smoke covers the typed client, demo provenance, validation, CORS and explicit unavailable mutation response. ML smoke covers real HTTP health and authentication on every internal route. Tests live beside their packages, plus `services/ml/tests`. `bun run build` produces `apps/web/dist` and `apps/api/dist`.

## Shared contract and ownership

- [Contract guide](docs/contracts.md): canonical field names, HTTP routes, model/DB inputs and invariants.
- [Foundation handoff](docs/handoffs/00-foundation.md): verification, open dependencies and next briefs.
- [Assumptions](docs/assumptions.md): choices made where the spec leaves implementation details open.
- [Master spec](../sort-fm-agent-handoffs/sort-fm-master-spec-v1.1.md) and [staged guide](../sort-fm-agent-handoffs/sort-fm-agent-handoffs/README.md).
- `AGENTS.md` fixes directory ownership. Integration lead owns `packages/contracts`, root scripts/config and contract version changes.

Use `@sortfm/contracts` for Zod schemas/types, `@sortfm/contracts/client` for the typed browser client, and `@sortfm/contracts/fixtures` only for synthetic demo data. JSON Schema for Python is generated at `packages/contracts/generated/contracts.schema.json`. Do not independently recreate TypeScript DTOs in feature modules.

The initial branch is `foundation`; no remote is configured. Original handoff files remain untouched outside this repository.
