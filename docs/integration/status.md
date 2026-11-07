# sort.fm integration state

Last coordination: November 7, 2026. Canonical remote: `origin/foundation` in `git@github.com:rao/sort.fm.git`. Approved initial baseline: `25a83e4` (foundation implementation `6cf29fa`).

## User authorization and operating scope

The user explicitly authorized continuous integration/architecture oversight, direct communication with the project agents, inspections, verification, normal commits/pushes and integration merges. Preserve the agents' implementation ownership; do not independently implement A1/B1/C1/D. Shared contracts and integration fixes belong to the integration lead. No force pushes, destructive resets, or staging another agent's unfinished files.

Recurring oversight is attached to integration chat `01a1b753-b9c8-7941-a258-ca9ffdf69301`, automation `sort-fm-integration-oversight`, every five minutes through November 8, 2026 at 11:00 AM America/New_York. Stay quiet on unchanged/non-actionable state; report meaningful progress, failures and decisions. This schedule depends on the local app's automation execution availability; it is not an always-running external daemon.

## Workspaces and agents

| Scope | Chat | Branch / workspace | Current coordination |
|---|---|---|---|
| Integration | Master Overseer (`01a1b753-b9c8-7941-a258-ca9ffdf69301`) | `integration`, `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-integration` | Sequential integration and shared contracts |
| A1 | A1 / Implement Spotify OAuth and import (`01a1b769-172a-74f3-92d8-87d3a52cd775`) | `a1-spotify-oauth-import`, sibling `sort.fm-a1` | Final checks; real D-adapter concurrency test awaits transaction-retry fix |
| B1 | B1 / Build polished sort.fm frontend (`01a1b76d-8785-7f81-af28-dcd2e811e0aa`) | `b1-delightful-ui`, sibling `sort.fm-b1` | Browser verification in progress; no completed handoff yet |
| C1 | C1 / Build personalized song-removal ML (`01a1b770-9f96-7be3-b215-cb7f869ef457`) | `c1-personalized-ml`, sibling `sort.fm-c1` | Completed module `fa0d749` integrated and verified; human-label evaluation remains open |
| D | D / Build SoundNet ingestion pipeline (`01a1b775-6f5a-75a1-af35-f60671918d54`) | `d-data-soundnet`, sibling `sort.fm-d` | Adapter/live DB checks in progress; bounded serialization retry needed |

Chat names above are the titles returned by the app. Discover current states rather than treating this table as live. Check `git worktree list`, `git status`, branch tips, and compact `wait_threads` snapshots before acting. The task's parent directory is not itself a repository; native worktree creation fails there, so these worktrees use Git directly.

## Contract decision

The foundation's `/score` input did not carry an exposure ID, so Python could not populate `/explain` snapshots through its HTTP boundary. Commit `c35cd96` adds `ScoringCandidate.exposureId?: UUID`, leaving Candidate/TrainingExample unchanged. C1 records immutable snapshots when this field is present; prior unkeyed requests remain valid. See `docs/contracts.md` for replay/conflict/atomicity semantics. Versions remain contract `1.0.0`, feature `sortfm.features.v1` for this additive prelaunch amendment. C1 took the same patch as `3084360`; account for the duplicate patch ancestry when merging. No extra endpoint is needed.

A1 supplied its transactional persistence port at `d4be70c`. It is now a type-only export from `@sortfm/contracts` in `packages/contracts/src/persistence.ts`, covering encrypted accounts and refresh leases, sessions, OAuth attempts, import checkpoints/raw observations, summary counts and optional taste context. Import review identified one additional operation, `completeImportMembership(ImportMembership)`, to atomically publish a completed scan without deleting retained snapshots/history on external unlikes. A1, D and B were sent the agreed current-count versus history-count semantics in `docs/contracts.md`. D implements this boundary; A1 retains local compatibility type re-exports, avoiding a DB package dependency on API application code. Serializability, detached reads, rollback, user scoping, original save dates and idempotent raw-observation keys are required. No wire schemas or versions changed.

## Integration procedure

1. Inspect branch/worktree/chat state and agent handoffs; never infer completeness from an idle thread alone.
2. Review focused committed changes for scope, secrets, DTO compatibility, actual tests and explicit unverified external dependencies.
3. Start clean integration work from canonical foundation; merge candidate commits in the isolated integration worktree. Keep unfinished working copies untouched.
4. Run relevant typecheck/tests/build/HTTP smokes and cross-service tests. Update foundation-only smoke expectations when a real capability lands; do not suppress meaningful failures.
5. Resolve integration-owned mismatches or return module defects to their owner. Do not advance P1 while P0 is failing.
6. Once canonical checkout is clean, advance foundation to the verified integration commit and push normally. If another agent changed foundation, fetch/reconcile its committed changes first; never overwrite or force-push.
7. Record verified flows, new commits, unresolved risks and next dependencies here and in the handoff. Inform affected agents about interface updates.

## Verified baseline and outstanding gates

Foundation: clean locked install, typecheck, build, 23 TypeScript tests, 54 Python tests, API/ML HTTP smoke, browser demo-load/error/recovery verified. No real provider mutation, DB connection, learned-model metric or production deployment is claimed yet.

A1/B1/D remain in progress. D reports a successful connection to the user's Tiger Data service and TimescaleDB 2.31.0 availability. A1 reports real-adapter auth/session/import checks passed before concurrent refresh exposed PostgreSQL `40001`. D is fixing bounded retries of fully rolled-back transactions; do not retry side-effecting callbacks or ambiguous commit failures. These DB checks are agent-reported evidence, not independent integration-lead migration/persistence proof. Live provider behavior and deployment remain unverified. The user stated their source-permission review was completed; provenance stays explicit without a source-specific implementation block.

Review of A1's first focused commit `6b06507` found a refresh concurrency blocker: the 120-second lease can expire before the HTTP retry budget finishes, while the failure path revokes credentials by version without checking the lease ID. A read-only reviewer reproduced stale-worker account revocation and session deletion with a deterministic two-worker harness against committed source. A1 reports the bounded/fenced fix at `3f886f6`, membership and import lease renewal at `e7a75f3`, and registrar at `56d3edc`. Await its final handoff and the live adapter retry fix before accepting that branch. No live Spotify failure is claimed. Next integration dependency: A1/D completed handoffs and combined API/database verification.

The optional exposure-ID amendment passes typecheck, **24 TypeScript tests / 109 assertions**, web/API build, and real API HTTP smoke. Its regression test failed before implementation and passed afterward, covering legacy unkeyed input, keyed input, malformed UUIDs, and unchanged training input. Python implementation is still C1's responsibility; the passing shared-contract test does not claim snapshot persistence is already implemented there.

The initial shared A1 persistence-type publication was verified against the exact declarations in `d4be70c`. Both that publication and the subsequent membership-completion type addition passed typecheck, **24 TypeScript tests / 109 assertions**, web/API build and API HTTP smoke. This verifies the type publication and existing baseline behavior; it does not claim a concrete adapter or import membership reconciliation is integrated. After each completed feature branch merge, rerun the relevant integration checks before accepting the next branch, preserving the shared public API schemas.

## C1 integration: completed module `fa0d749`

Merged the finished C1 branch into the isolated integration checkout. Its duplicate exposure-contract cherry-pick caused only an add/add conflict in this log; retained the newer canonical coordination record. Shared public/internal wire schemas are unchanged, confirmed by regenerating all 61 JSON schemas with zero diff. A read-only independent review found no P0/P1 merge blocker.

Fresh checks on the merged tree: **214 Python tests**, **24 TypeScript tests / 109 assertions**, TypeScript typecheck, web/API build, API HTTP smoke, Python HTTP train/score/revoke/replay/restart/explain smoke, and a new root TypeScript-to-FastAPI integration smoke all pass. The root smoke now exercises authenticated implemented endpoints, validates actual response refinements with shared Zod schemas, verifies cold-start null probability, computed synthetic holdout metrics, training-count reduction on Undo, idempotency, immutable exposure replay, conflict handling and user isolation. It uses a temporary artifact directory and makes no provider calls. A cold scientific-runtime start exceeded the old 10-second smoke window; readiness now allows a bounded 30 seconds including environment startup. The initial new smoke expected `unavailable`; inspection confirmed `insufficient_data` is the correct contract status for an untrained service, and the assertion was corrected.

Integrated code lives under `services/ml/**`; root integration changes are `scripts/smoke-ml.ts`, the ML README smoke instructions and this log. Real human-label/real-listener evaluation remains an open acceptance gate: the authored fixture and recorded experiments are explicitly synthetic and do not demonstrate superiority over every control. Keep one ML replica with durable POSIX artifact storage. No real Spotify/SoundNet data, production deployment or public API-to-ML routing is claimed by this merge. The next API/queue work must call this service with server-authenticated identity and persist exposure/feedback revisions through the shared contracts.
