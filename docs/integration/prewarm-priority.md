# Private prewarm priority export

`scripts/prewarm-priority.ts` supplies D's optional `--priority-file` input. It calls A1's `readPrewarmPriority` once and writes only a JSON array of at most 25 unique track IDs. It does not call a queue route, create exposures, fit/score a model, enqueue work, call Spotify/Musicae/SoundNet or change application rows. Labeling never waits for this operator task.

## Usage

Run from the repository root with the intended private server environment explicitly selected:

```sh
bun --env-file=/absolute/private/server.env scripts/prewarm-priority.ts \
  --user-id OWNER_ID \
  --output /absolute/private/prewarm/run-unique/priority.json \
  --limit 25 --recent-minutes 30
```

The environment supplies `DATABASE_URL` and optional `DATABASE_SCHEMA` (default `sortfm`). No environment values are logged. Success prints only `{"count":N,"path":"..."}`; IDs appear only in the file. Errors are sanitized. Pass the resulting file to D's existing operator tool separately; this export never starts enrichment itself.

The output must be an absolute canonical path outside every Git checkout, including ignored directories and linked worktrees. Use a real path without symlink components (`/private/tmp` rather than macOS's `/tmp` alias). Newly created directories are 0700; an existing final parent must already be 0700 and owned by the current user. Existing output files and symlinks are rejected. The directory is revalidated after the snapshot, and creation uses exclusive/no-follow flags with 0600 permissions. Choose a new destination for each run. As with other local private operator files, use a trusted filesystem controlled by this account; this is not a sandbox against a malicious process running as the same OS user.

## Snapshot and ordering

`createDatabasePrewarmPort(db, now)` implements A1's read port with one `REPEATABLE READ READ ONLY` transaction. The same captured `now` is passed to the adapter and selector. It validates the owner, checks the 10,000-row library bound, calls D's exported `readLibrary(tx,userId)`, reads authoritative calibration eligibility, and reads recent persisted exposure summaries. `lockUser` would use `FOR UPDATE`, which PostgreSQL prohibits in a read-only transaction; the approved MVCC approach avoids blocking the labeling owner while retaining one consistent database image.

Eligibility is the exact predicate from `PostgresCalibrationStore.calibrationCandidates` in `packages/db/src/calibration.ts`: current membership, playable real Spotify metadata, saved/deferred status, acceptable current cleanup state, no active effective label, no pending/retryable cleanup anywhere in track history, and no unsettled Undo even with an expired lease. The root-owned copy has a source-reference comment and a real database parity test; update both when D changes that authority. Shared contracts and DB/API implementation files are untouched.

Recent records are owner-scoped and bounded at 250. Both cutoff endpoints are inclusive. Review consumption comes from `exposure_consumptions`; calibration consumption comes from `calibration_labels`, including subsequently revoked labels. Consumed, expired and future records are filtered before the bound. Ordering is newest `served_at`, purpose in C collation, ascending batch position, then exposure UUID. A1 intersects these records with current eligibility, deduplicates, and fills from its unchanged diverse calibration selector. Issued exposures do not establish that the browser displayed every card.

After commit the snapshot is advisory: membership, labels and provider state may change. D remains responsible for its provider cache, quarantine, terminal-failure and in-flight checks and can accept fewer IDs. Nothing in this file rewrites old exposure features or promises that enrichment affects already-issued cards.

## Verification

- File/argument fixtures cover JSON-only output, 0700/0600 modes, no overwrite, Git checkout/worktree exclusion, symlink rejection including directory replacement during the read, and failed-read behavior.
- Opt-in integration tests use only a new random `test_prewarm_<uuid>` schema. They compare eligibility with D, check both command namespaces and batch ordering, prove consumption filtering before the bound, compare every application table's count/digest before/after reads, and interleave a real second-connection membership/label change after the library read to prove snapshot consistency. A full CLI invocation verifies private output and count/path-only logs.

```sh
bun test scripts/prewarm-priority.test.ts
# Set privately; only disposable schemas are created and removed.
PREWARM_TEST_DATABASE_URL=... bun test scripts/prewarm-priority.integration.test.ts
bun run typecheck
bun test
bun run build
bun run smoke
```

The integration test does not use `DATABASE_SCHEMA` or an existing application schema, and its teardown checks the exact generated test-schema shape. Production export, provider enqueue/cache behavior and live user queue contents are separate acceptance checks and are not claimed by these tests.

Verified on this isolated branch: five file/argument tests passed (29 assertions); four disposable Tiger tests passed (29 assertions), including the actual CLI and concurrency interleaving. Root typecheck, full default suite (594 passed, 84 environment-gated skips, 0 failed; 3,188 assertions), web/API production builds and foundation HTTP smoke passed. Build output retains the existing two Zod annotation warnings. No live application export, provider calls, production labels or model changes were performed.
