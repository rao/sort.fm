# Musicae enrichment operations

The worker is independent of API startup. Deploy migration `013_musicae.sql` and the additive Musicae TypeScript/Python reader contracts before starting it. Existing SoundNet caches win overlaps; historical exposure and training snapshots are never rewritten. Missing or quarantined features remain null/absent and the rest of the application remains usable.

## Start and resume

From the repository root, with server credentials in the ignored `.env`:

```sh
bun --env-file=.env packages/db/src/migrate.ts
bun --env-file=.env apps/api/src/jobs/soundnet/musicae-cli.ts smoke --user spotify:example.owner --priority-file /absolute/private/priority.json
bun --env-file=.env apps/api/src/jobs/soundnet/musicae-cli.ts status --user spotify:example.owner
bun --env-file=.env apps/api/src/jobs/soundnet/musicae-cli.ts run --user spotify:example.owner --max-requests 4
bun --env-file=.env apps/api/src/jobs/soundnet/musicae-cli.ts run --user spotify:example.owner --max-requests 650
```

The integration lead runs the live migration after reader release approval. In a development worktree, replace `--env-file=.env` with `--env-file=../sort.fm/.env`. `smoke` enqueues missing library tracks and makes at most one five-track request. Inspect status and the first response before bulk work. Four more requests warm up to 25 uncached tracks total. The 650-call example is a bounded library pass, not a guarantee that every track is available or passes validation. `run` resumes existing jobs; it does not reset failures, quarantine, or attempts. `enqueue` can add newly imported tracks or an updated priority file without making API calls. Ctrl-C is safe; repeat the same `run` command to resume.

The private priority file is a JSON array of Spotify IDs in desired order. Prefer currently served, still eligible and unlabeled review/calibration candidates, then the next deterministic calibration candidates. Obtain this via the read-only API exporter; do not call a queue endpoint just to generate warming candidates, since that creates immutable exposures. Default priority is saved tracks before deferred tracks, then original save date/ID; it is a fallback, not a learned prediction of the next session.

## Environment and interfaces

- `DATABASE_URL`, optional `DATABASE_SCHEMA` (default `sortfm`), with existing PgBouncer-compatible database tooling.
- `MUSICAE_RAPIDAPI_KEY`, falling back to `SOUNDNET_RAPIDAPI_KEY` for the same RapidAPI account. Never place keys in logs or URLs.
- `MUSICAE_TIMEOUT_MS`, default 30000, permitted 1–120000. Includes receiving the entire body.
- `MUSICAE_RIGHTS_BASIS`: truthful server-side rights assertion. Without it, accepted features are cached but explicitly not permitted for training. Pro subscription alone is not interpreted as a training license.
- `MusicaeQueue.enqueueUser(userId, priorityIds)`, `.progress(userId)`, `.audioStatus(userId)` for orchestration/status. `Repository.library` projects the accepted cache; Python receives it through existing feature DTO/export interfaces. Feature order/version and units are unchanged. Musicae valence is not aliased to happiness; happiness and SoundNet popularity remain null.

## Limits and recovery

One global durable provider lease permits one in-flight request, with at least one second between starts and at most five IDs per request. Quota/start accounting commits before HTTP launch; a second lease check fences delayed launchers. Failed or indeterminate dispatches retain their conservative quota reservation. Persisting a response adds a one-second cooldown, so delayed launches cannot compress request spacing. One request can establish the plan headers; continued bulk work requires a reported quota limit of at least 1000. Keep a two-request quota reserve. Honor `Retry-After` and quota reset; stop a CLI run rather than wait more than its bounded cooldown budget. HTTP 401/403 block immediately. Three consecutive server, transport, timeout, or malformed batch failures open a durable circuit. Individual tracks get at most three attempts, with exponential jittered backoff; crashes without saved responses consume attempts too.

Raw responses and safe request evidence commit before normalization. A crash after this checkpoint replays without a provider request, even if the quota or plan gate blocks new requests. Expired attempts are fenced from publishing later. HTTP dispatch and quota counters are serialized across workers. There is no exactly-once guarantee for a provider call whose process dies before its response is committed; the indeterminate request is retained and retry bounds still apply.

Circuit/auth blocks deliberately have no automatic reset command. Investigate the persisted request evidence and provider health before an operator clears a block. Re-enqueue does not bypass safety limits. Never reset all attempts as a routine restart step.

## Data quality and evidence

Each batch is matched by exact Spotify ID, URI and duration; no positional matching. Validate numeric ranges and missingness. Whole-second durations combined with unit features rounded entirely to hundredths are quarantined as possible coarse estimates, not claimed to be proven fabricated. Fewer than four consumed unit fields are also quarantined. Quarantine retains raw evidence but is excluded from the feature view and training. Accepted features have `measuredAccuracyVerified: false`: structural/identity checks do not independently validate measured audio accuracy.

`musicae_requests` retains HTTP status, elapsed milliseconds, allowed quota headers, retry delay, raw body/error category and expected track identity. CLI logs emit counts and safe metadata without raw bodies or credentials. `musicae_jobs` retains progress/error codes and bounded attempts. Keep library-linked diagnostics private outside Git.

Run mocked-provider and real-Postgres recovery checks with a disposable-schema database:

```sh
TEST_DATABASE_URL=postgres://localhost/postgres bun test packages/db/test/musicae-provider.test.ts packages/db/test/musicae-queue.test.ts packages/db/test/musicae-worker.test.ts packages/db/test/calibration-migration.test.ts
bun run typecheck
bun run build
```
