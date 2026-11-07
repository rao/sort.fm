# Production packaging

The deployment runbook is [`docs/integration/production.md`](../docs/integration/production.md). These build inputs contain no credentials or local model artifacts. Provide secrets only as service runtime variables.

## Vercel frontend

Use project Root Directory `apps/web` and **enable “Include source files outside of the Root Directory in the Build Step.”** The app-root `vercel.json` installs the frozen root workspace and builds only `@sortfm/web`; Vercel serves `apps/web/dist`. Keep the repository-root `.vercelignore` so CLI uploads retain workspace manifests/contracts and omit backend code, Python, secrets, and local state.

Set the public build variable `VITE_API_ORIGIN=https://api.sort.fm`. This is the name read by the frontend. No provider credential, shared secret, database URL, or owner identifier belongs in a `VITE_` variable. Bun install and build explicitly use version `1.4.3` through `npx --yes bun@1.4.3`. The prior `bunx` bootstrap exited before dependency installation on Vercel; the pinned npm bootstrap passed both a clean local production upload-context build and the actual Vercel Linux deployment at `fd154b0`.

## Railway services

Configure the following settings through the current dashboard or API. Both Dockerfiles require the **repository root** as the build context. Do not set their Root Directory to `apps/api`, `services/ml`, or `deploy`.

| Setting | API service | ML service |
| --- | --- | --- |
| Root Directory | Repository root | Repository root |
| Builder | Dockerfile | Dockerfile |
| Dockerfile path / `RAILWAY_DOCKERFILE_PATH` | `deploy/api/Dockerfile` | `deploy/ml/Dockerfile` |
| Build/start command overrides | Unset; use Dockerfile | Unset; use Dockerfile |
| Pre-deploy command | Unset; migrations are explicit operator work | Unset |
| Replicas | 1 | 1 |
| Serverless / sleeping | Disabled; API runs durable workers | Disabled |
| Healthcheck path | `/api/health` | `/health` |
| Healthcheck timeout | 120 seconds | 120 seconds |
| Restart policy | On failure, maximum 10 retries | On failure, maximum 10 retries |
| Deployment drain time | 60 seconds | 60 seconds |
| Public domain | `api.sort.fm` | None; no generated domain or TCP proxy |
| Volume mount | None | `/data/ml` |

These checks are liveness only. A healthy response does not verify database migrations, provider credentials, ML authentication, storage durability, or live capability readiness.

Use a new Railway environment with IPv4 private networking and place API/ML in the same project/environment. The ML listener binds `0.0.0.0`; Railway environments created after October 16, 2025 support IPv4 and IPv6 private addresses. An older IPv6-only environment requires a different listener configuration before use. Set the ML service `PORT=8000`, `ML_ARTIFACT_DIR=/data/ml`, and `ML_SERVICE_SHARED_SECRET`. Point the API's `ML_SERVICE_URL` to `http://<ml-service-private-domain>:8000` and supply the same shared secret. Set API `ML_ALLOW_RAILWAY_PRIVATE_HTTP=true` only within this isolated Railway environment; the default-false client otherwise rejects remote HTTP. Railway protects that HTTP hop with its private network encryption. Mount the persistent volume before starting real work; the image does not initialize or import local artifacts. The ML image runs one Uvicorn worker as root to match Railway's root-owned volume mount.

The API image sets `NODE_ENV=production` and `HOST=0.0.0.0`, respects Railway's `PORT`, and runs only the built JavaScript bundle. Its final image intentionally contains no migrations or source checkout. Run reviewed migrations explicitly from an operator checkout with the production environment before starting the API. Neither image performs migrations, trains a model, or contacts providers during its build.

New services cannot use deprecated `railway.json` / `railway.toml` Config as Code. Railway's replacement is project-level IaC, which requires its SDK/CLI. No obsolete config files or new SDK dependency are included here. Relevant primary references: [Config as Code retirement](https://docs.railway.com/config-as-code/reference), [current IaC](https://docs.railway.com/infrastructure-as-code), [Dockerfile paths](https://docs.railway.com/builds/dockerfiles), [private networking](https://docs.railway.com/networking/private-networking/how-it-works), and [volume permissions](https://docs.railway.com/volumes).

## Local image checks

When a Docker daemon is available, run from the repository root:

```sh
docker build -f deploy/api/Dockerfile -t sortfm-api:local .
docker build -f deploy/ml/Dockerfile -t sortfm-ml:local .
```

Runtime images are pinned by version and multi-platform digest: `oven/bun:1.4.3-slim`, `python:3.11.14-slim-bookworm`, and the build-only `ghcr.io/astral-sh/uv:0.10.4`. The registry manifests were checked on November 7, 2026. ML installs `uv.lock` with `--locked --no-dev --no-editable`; the runtime receives only the installed environment. The authored synthetic fixture is a required package input, not a saved user model. See the [Bun Docker guide](https://bun.com/guides/ecosystem/docker) and [uv Docker guide](https://docs.astral.sh/uv/guides/integration/docker/).
