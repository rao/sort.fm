# sort.fm

**Your music taste evolved. Your Liked Songs didn't.**

Built for UB Hacking 2026, sort.fm helps you rediscover the songs you love and make room for what moves you now. Connect Spotify, work through your library one song at a time, and teach a personal preference model along the way. You make every keep-or-remove decision.

[Try the demo](https://sort.fm/?mode=demo#/library) · [Visit sort.fm](https://sort.fm) · [Run locally](#run-locally) · [Explore the code](#find-your-way-around)

## A little less scrolling. A little more listening.

- **Review your Liked Songs.** Import your library, then Keep, Archive, Skip, or Unlike with swipe cards and keyboard shortcuts. Archive saves a song to a private playlist before removing its like; Undo restores the like while retaining the archive copy.
- **Teach your taste.** Mark what you would keep or remove without changing anything in Spotify. Teach and review feedback feed the same personal model, with history and correction controls.
- **Understand the suggestions.** See removal estimates, contributing features, training progress, and held-out evaluation in Insights and Model Lab. Explore musical neighbors in the Taste Constellation and your library across release years.
- **Listen as you go.** Open tracks in Spotify, control a connected device, or enable browser playback. Browser playback requires separate consent and [Spotify Premium](https://developer.spotify.com/documentation/web-playback-sdk/howtos/web-app-player).
- **Take a no-login tour.** The isolated demo uses fictional songs and simulated decisions. It never touches a Spotify library.

The hosted Spotify connection is restricted to allowlisted accounts; everyone can explore the demo. For your own library, run your own instance below.

## Under the hood

React 19, Vite, and Tailwind CSS power the interface. A Bun/Fastify API handles Spotify OAuth, library imports, and durable review workflows in PostgreSQL. A private Python/FastAPI service uses scikit-learn to fit a per-listener logistic regression model from explicit feedback.

New accounts start with a transparent heuristic. Predictions become learned estimates only when enough eligible feedback exists; missing features and unavailable metrics stay visible as missing. Feedback revisions, fixed train/holdout splits, and saved prediction snapshots keep training and explanations traceable. Experimental LinUCB review selection is included but **disabled by default**; it is not a claim of better recommendations.

## Run locally

### 1. Try the demo

Install Git and **Bun 1.4.3+**, then run:

```sh
git clone https://github.com/rao/sort.fm.git
cd sort.fm
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

Open [the local demo](http://127.0.0.1:5173/?mode=demo#/library). This starts the web app on port **5173** and API on **3001**, with `/api` proxied by Vite. No Spotify credentials, database, or Python service are needed. Missing live-service configuration messages are expected in demo mode.

### 2. Connect your own Spotify account

You will also need **PostgreSQL**, **uv**, and **Python 3.11+** for the full stack; uv can provision Python. Use a separate database for your instance.

1. Create your own [Spotify developer app](https://developer.spotify.com/documentation/web-api/concepts/apps). Register `http://127.0.0.1:3001/api/auth/spotify/callback` exactly, and add your test account to the app's user access list as required by Spotify's development mode.
2. Fill in the root `.env` using the table below. Keep the supplied local origins and callback, and use `127.0.0.1` consistently in your browser.
3. Stop the demo server, install Python dependencies, and apply the database migrations:

```sh
uv sync --locked --directory services/ml
bun --env-file=.env packages/db/src/migrate.ts
```

| Variable | Set it to |
| --- | --- |
| `DATABASE_URL` | Your PostgreSQL connection URL; `DATABASE_SCHEMA` defaults to `sortfm`. |
| `SPOTIFY_CLIENT_ID` | Your developer app's client ID. OAuth uses PKCE; `SPOTIFY_CLIENT_SECRET` is unused. |
| `SPOTIFY_ALLOWED_USER_IDS` | Your Spotify profile ID, or a comma-separated list of allowed IDs. |
| `SESSION_SECRET` | A random secret of at least 32 characters. |
| `TOKEN_ENCRYPTION_KEY` | Base64-encoded 32 random bytes. |
| `ML_SERVICE_SHARED_SECRET` | A random shared secret for the API and ML service. |
| `ML_SERVICE_URL` | Keep `http://127.0.0.1:8000` for local development. |
| `METADATA_RIGHTS_BASIS` | Your reviewed basis for using the source metadata in training; absent means metadata is not permitted for training. |

For each of the three secrets, generate a **different** value with `openssl rand -base64 32`. Store those values in `.env` and preserve them across restarts.

Start the ML service in one terminal and the app in another, both from the repository root:

```sh
# Terminal 1
bun run dev:ml
```

```sh
# Terminal 2
bun run dev
```

Open [the local app](http://127.0.0.1:5173), connect Spotify, and import your Liked Songs. Use **Teach** to provide preferences without changing your library; **Review** can make real Spotify changes. Audio enrichment is optional and has its own provider setup; see the [database and ingestion guide](packages/db/README.md).

## Find your way around

| Path | What's inside |
| --- | --- |
| [`apps/web/`](apps/web/) | React screens and components, API clients, review state, playback, and visualizations. Start at [`src/App.tsx`](apps/web/src/App.tsx). |
| [`apps/api/`](apps/api/) | Fastify routes, OAuth, Spotify integration, review/calibration workflows, and background workers. Start at [`src/runtime.ts`](apps/api/src/runtime.ts). |
| [`services/ml/`](services/ml/) | Preference model, experimental selection policies, training/evaluation tools, and Python tests. |
| [`packages/contracts/`](packages/contracts/) | Shared Zod schemas, TypeScript types, typed API client, demo fixtures, and exported JSON Schema. |
| [`packages/db/`](packages/db/) | PostgreSQL repositories, migrations, feedback persistence, and ingestion queues. |
| [`scripts/`](scripts/) | Development launchers, contract export, and smoke checks. |
| [`deploy/`](deploy/) | API/ML Dockerfiles and hosting instructions. |
| [`docs/`](docs/) | Contracts, architecture decisions, experiments, and integration history. |

For a deeper read: [shared contracts](docs/contracts.md) · [ML guide](services/ml/README.md) · [deployment guide](deploy/README.md) · [integration status](docs/integration/status.md). Handoff notes record earlier milestones; the implementation and latest status entries reflect subsequent changes.

## Build, check, and make it yours

Run these from the repository root:

```sh
bun run typecheck       # TypeScript checks
bun run test            # JS/TS tests; external integration tests are opt-in
bun run build           # apps/web/dist and apps/api/dist
bun run smoke           # Local API/demo HTTP check
bun run test:ml         # Python tests (requires uv)
bun run smoke:ml        # API-contract ↔ Python HTTP check (requires uv)
```

Use Bun with the root `bun.lock` for JavaScript and uv with `services/ml/uv.lock` for Python. If you change shared schemas, run `bun run contracts:export` and keep both services aligned.

To work from a fork, fork [rao/sort.fm](https://github.com/rao/sort.fm), substitute your fork's URL in the clone command, and create a branch with `git switch -c your-change`. Configure your own Spotify app, database, and secrets. Keep `.env`, private library exports, and model artifacts out of Git; only public browser configuration belongs in `VITE_*` variables.

For hosting, the [deployment guide](deploy/README.md) covers Vercel for the frontend, Railway for the API/private ML service, and PostgreSQL/Tiger Data. Configure your own origins and Spotify callback, run migrations explicitly, and give ML persistent storage.

**License:** This repository does not yet include a project-wide license. A license from the maintainers is still needed to establish broader reuse and redistribution terms. The included BoardUI code has its own [MIT notice](apps/web/BOARDUI-LICENSE).
