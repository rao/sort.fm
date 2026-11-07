# sort.fm integration state

Last coordination: November 7, 2026. Canonical remote: `origin/foundation` in `git@github.com:rao/sort.fm.git`. Approved initial baseline: `25a83e4` (foundation implementation `6cf29fa`).

## User authorization and operating scope

The user explicitly authorized continuous integration/architecture oversight, direct communication with the project agents, inspections, verification, normal commits/pushes and integration merges. Preserve the agents' implementation ownership; do not independently implement A1/B1/C1/D. Shared contracts and integration fixes belong to the integration lead. No force pushes, destructive resets, or staging another agent's unfinished files.

Recurring oversight is attached to integration chat `01a1b753-b9c8-7941-a258-ca9ffdf69301`, automation `sort-fm-integration-oversight`, every five minutes through November 8, 2026 at 11:00 AM America/New_York. Stay quiet on unchanged/non-actionable state; report meaningful progress, failures and decisions. This schedule depends on the local app's automation execution availability; it is not an always-running external daemon.

## Workspaces and agents

| Scope | Chat | Branch / workspace | Current coordination |
|---|---|---|---|
| Integration | Master Overseer (`01a1b753-b9c8-7941-a258-ca9ffdf69301`) | `integration`, `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-integration` | Sequential integration and shared contracts |
| A1 | A1 / Implement Spotify OAuth and import (`01a1b769-172a-74f3-92d8-87d3a52cd775`) | `a1-spotify-oauth-import`, sibling `sort.fm-a1` | Completed module `74977aa` integrated; production bootstrap awaits D |
| B1 | B1 / Build polished sort.fm frontend (`01a1b76d-8785-7f81-af28-dcd2e811e0aa`) | `b1-delightful-ui`, sibling `sort.fm-b1` | Completed demo `7b81689` integrated and browser-verified; B2 live wiring remains |
| C1 | C1 / Build personalized song-removal ML (`01a1b770-9f96-7be3-b215-cb7f869ef457`) | `c1-personalized-ml`, sibling `sort.fm-c1` | C1 engineering accepted by user; API-only ML adapter in progress, C2 separate |
| D | D / Build SoundNet ingestion pipeline (`01a1b775-6f5a-75a1-af35-f60671918d54`) | `d-data-soundnet`, sibling `sort.fm-d` | D through `76c7256` integrated; feedback reconciliation interface in progress |

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

D remains in progress; A1 and B1 completed modules are integrated. D reports a successful connection to the user's Tiger Data service and TimescaleDB 2.31.0 availability. A1's real-adapter test initially exposed PostgreSQL `40001`; after D added bounded retries of fully rolled-back transactions, A1 reports the test passes (1 test / 10 assertions): encrypted OAuth persistence, paginated import/membership, session reload, one provider refresh across two workers, resync from three tracks to one while preserving all three historical rows, and persisted logout. Provider responses were mocked, database was real, and the disposable test schema was cleaned. The tested D adapter is still being finalized; repeat against committed integrated code before accepting it. Do not retry side-effecting callbacks or ambiguous commit failures. These DB checks are agent-reported evidence, not independent integration-lead migration/persistence proof. Live provider behavior and deployment remain unverified. The user stated their source-permission review was completed; provenance stays explicit without a source-specific implementation block.

Review of A1's first focused commit `6b06507` found a refresh concurrency blocker: the 120-second lease can expire before the HTTP retry budget finishes, while the failure path revokes credentials by version without checking the lease ID. A read-only reviewer reproduced stale-worker account revocation and session deletion with a deterministic two-worker harness against committed source. A1 reports the bounded/fenced fix at `3f886f6`, membership and import lease renewal at `e7a75f3`, and registrar at `56d3edc`. The completed handoff and independent review now confirm these fixes; see the A1 integration record below. No live Spotify failure is claimed. Next integration dependency: D's completed adapter and combined API/database verification.

The optional exposure-ID amendment passes typecheck, **24 TypeScript tests / 109 assertions**, web/API build, and real API HTTP smoke. Its regression test failed before implementation and passed afterward, covering legacy unkeyed input, keyed input, malformed UUIDs, and unchanged training input. Python implementation is still C1's responsibility; the passing shared-contract test does not claim snapshot persistence is already implemented there.

The initial shared A1 persistence-type publication was verified against the exact declarations in `d4be70c`. Both that publication and the subsequent membership-completion type addition passed typecheck, **24 TypeScript tests / 109 assertions**, web/API build and API HTTP smoke. This verifies the type publication and existing baseline behavior; it does not claim a concrete adapter or import membership reconciliation is integrated. After each completed feature branch merge, rerun the relevant integration checks before accepting the next branch, preserving the shared public API schemas.

## C1 integration: completed module `fa0d749`

Merged the finished C1 branch into the isolated integration checkout. Its duplicate exposure-contract cherry-pick caused only an add/add conflict in this log; retained the newer canonical coordination record. Shared public/internal wire schemas are unchanged, confirmed by regenerating all 61 JSON schemas with zero diff. A read-only independent review found no P0/P1 merge blocker.

Fresh checks on the merged tree: **214 Python tests**, **24 TypeScript tests / 109 assertions**, TypeScript typecheck, web/API build, API HTTP smoke, Python HTTP train/score/revoke/replay/restart/explain smoke, and a new root TypeScript-to-FastAPI integration smoke all pass. The root smoke now exercises authenticated implemented endpoints, validates actual response refinements with shared Zod schemas, verifies cold-start null probability, computed synthetic holdout metrics, training-count reduction on Undo, idempotency, immutable exposure replay, conflict handling and user isolation. It uses a temporary artifact directory and makes no provider calls. A cold scientific-runtime start exceeded the old 10-second smoke window; readiness now allows a bounded 30 seconds including environment startup. The initial new smoke expected `unavailable`; inspection confirmed `insufficient_data` is the correct contract status for an untrained service, and the assertion was corrected.

Integrated code lives under `services/ml/**`; root integration changes are `scripts/smoke-ml.ts`, the ML README smoke instructions and this log. Real human-label/real-listener evaluation remains an open acceptance gate: the authored fixture and recorded experiments are explicitly synthetic and do not demonstrate superiority over every control. Keep one ML replica with durable POSIX artifact storage. No real Spotify/SoundNet data, production deployment or public API-to-ML routing is claimed by this merge. The next API/queue work must call this service with server-authenticated identity and persist exposure/feedback revisions through the shared contracts.

C1 merge commit `e88468e` was pushed and its remote `foundation` SHA verified. The canonical checkout was clean afterward.

## A1 integration: completed module `74977aa`

The completed A1 branch merged cleanly after C1. A fresh independent read-only review confirmed the original refresh race is fixed and found no remaining P0/P1 blocker. Shared persistence types are consumed through compatibility re-exports; no wire contracts changed.

Fresh merged-tree checks pass: typecheck, **68 TypeScript tests / 592 assertions**, web/API build, standalone A1 module bundle, API HTTP smoke, TypeScript-to-ML HTTP smoke, contract regeneration with zero schema diff, and whitespace checks. The one opt-in DB test is explicitly skipped in this default run until D's completed adapter is integrated. Tests include a controlled-provider real HTTP session/import flow, 2,700-track fixture pagination, recovery, original timestamps, current membership, stale refresh fencing and lease renewal. No real Spotify account or mutation was used.

Changes are `apps/api/src/auth/**`, `spotify/**`, `library/**` and the minimal `app.ts` registrar ordering adjustment. `index.ts` remains conservatively on foundation bootstrap until the lead installs D's production adapter and verifies it. Health capabilities therefore remain false for live Spotify/database. A1's agent-reported live Tiger test is not yet the lead's committed-tree verification. See `apps/api/src/auth/HANDOFF.md` for exact scope and unverified provider/deployment gates.

## B1 integration: completed frontend `7b81689`

Merged B1 after the verified A1 merge `9dab2fa`. The merge was clean. A read-only review found no P0/P1 blocker and confirmed demo-only behavior, honest unavailable metrics, stable retry identities and confirmed-result gating. B1 source changes are confined to `apps/web/**`; root integration adds this record and `docs/integration/b1-browser.jpg`.

Fresh combined checks: locked Bun install (no changes), typecheck, **86 TypeScript tests / 651 assertions / 0 failures** with the one opt-in D adapter test still explicitly skipped, web/API build, API HTTP smoke, shared TypeScript-to-ML HTTP smoke, unchanged regenerated JSON schemas and diff checks all pass. C1's 214 Python tests passed at its own integration; Python source is unchanged by A1/B1.

The integration lead also ran the merged production preview at an isolated loopback port: landing/demo import/review, asynchronous decision locking, Archive settlement, Undo restoration with feedback count returning to zero, and simulated decision failure/retry all behaved correctly. The failed request kept its song; Retry produced one settled decision and advanced once. Predictions remained unavailable and the fictional-data/no-Spotify-write banner remained visible. Saved browser proof: `docs/integration/b1-browser.jpg`. The temporary preview process/tab were closed after verification. B1's own broader desktop/mobile/gesture evidence is in `apps/web/docs/B1-handoff.md`; this lead smoke does not claim a new mobile or accessibility-device audit.

B1 is a functioning isolated local demo, not yet a connected live UI. B2 still owns session/OAuth integration, live import progress, queue pagination, persisted command recovery, history and metrics refresh, and playback availability. Do not attach fictional demo exposures to real Spotify mutations. The next completed backend dependency is D, followed by real adapter/bootstrap verification and B2/A2 integration.

## Local OAuth configuration gate

The canonical ignored `.env` had empty `TOKEN_ENCRYPTION_KEY`, `SESSION_SECRET` and `SPOTIFY_ALLOWED_USER_IDS`. The integration lead generated the two missing server secrets, validated a canonical-base64 32-byte encryption key and sufficiently long session secret, and restricted the file to mode 0600. Existing configured values were preserved; no secret values were printed or committed. The user has been asked for the exact Spotify owner ID. Keep live OAuth disabled while the allowlist is empty. Registered redirect matching and real-owner consent still require live verification after A1/D wiring; generation of local secrets is not provider proof.

## Active real-data integration — November 7, 2026

The user explicitly accepted C1 engineering and shifted priority to OAuth → real library import → Tiger Data → C1 scoring → persistent review queue. Human-label efficacy remains unverified but is not a blocker for this engineering integration. Foundation is the repository's canonical default branch; references to “main” mean that branch, not a new divergent branch.

Ownership has been reconfirmed with the existing agents: integration owns bootstrap/app registrars/root scripts and canonical merges; A owns authenticated queue and A2 review/Undo with durable model feedback; B owns P0 live frontend wiring; C1 owns an isolated `apps/api/src/ml/**` transport/feature assembly adapter without changing the accepted Python service; D owns persistence/enrichment and atomic feedback reconciliation storage. C2 is running separately in `sort.fm-c2` (`c2-contextual-bandit`, chat `01a1b787-dcd2-7291-94bb-753a86557bd0`). No overlapping edits or new ownerless feature work.

The ignored canonical `.env` now also has a generated server-only ML shared secret and a SoundNet rights-basis string recording the user's explicit source-use attestation. No secret values were printed or committed. The only missing local OAuth setting remains `SPOTIFY_ALLOWED_USER_IDS`; the exact configured redirect equals the API callback, but registration at Spotify and owner consent are still unverified.

## D integration — completed branch through `76c7256`

Merged the completed D branch including its focused cloud-test timeout fix. Duplicate shared-port ancestry caused one coordination-log conflict; retained the current canonical log. Shared contracts and generated schemas are unchanged. An independent read-only review found no confirmed P0/P1 blocker.

Fresh integrated checks pass: locked install, typecheck, web/API build, foundation HTTP smoke, TypeScript-to-C1 HTTP smoke, all **214 Python tests**, contract regeneration with zero diff, and **108 TypeScript tests / 778 assertions / zero failures** against actual Tiger Data with a bounded 30-second cloud-test timeout. A1's real-adapter test passed, verifying encrypted OAuth persistence, failed-page rollback/resume, reconstructed sessions, concurrent refresh fencing, membership resync and logout using controlled Spotify responses. DB tests create and remove only disposable generated schemas; they do not seed the application schema.

The first cloud suite exposed two five-second settlement-test timeouts, a cleanup-hook timeout and one connection startup timeout. Targeted reruns reproduced no assertion or lock defect, and D independently measured network/transaction latency. The two settlement cases and their lifecycle now have explicit 30-second bounds in `2b75d12`; the combined rerun passed with a 30-second command bound. This is documented cloud-test tolerance, not a production behavior change or hidden failure.

Independent inspection confirms all six migrations are present in the real `sortfm` schema, TimescaleDB **2.31.0**, and the actual telemetry hypertable. Running migration again returns `applied: []`, `hypertable: true`. Main application data is still **0 users / 0 tracks / 0 telemetry events / 0 cached features**. No real Spotify import, SoundNet request, cleanup mutation or model feedback delivery is claimed.

Next dependency: integration bootstrap injects `PostgresA1Store`; A and C1 publish the live queue/ML adapter; D adds durable revision-keyed fit reconciliation agreed with A. SoundNet CLI can run independently once imported Spotify IDs exist; run and inspect five distinct-artist samples before approving/enqueuing backfill. Missing audio never blocks metadata scoring. Real owner ID/consent is the external prerequisite for real songs.

Follow-up verification before publishing D: `559f01f` bounds A1 DB lifecycle hooks; `76c7256` fixes eager connection construction inside skipped test suites. A fresh no-credentials run now skips DB suites without errors. The independent 35-second slow-provider test passed (1 test / 4 assertions), confirming the core HTTP path stays responsive. A later full Tiger rerun passed all persistence/A1 checks but hit the limiter test's explicit 15-second bound; its isolated unchanged rerun passed in 7.87 seconds with all 12 pacing assertions. Cloud DB timing remains variable; no rate-limit assertion failure or persistence correctness defect was reproduced. Root bootstrap edits were developed independently and are not part of this D merge.

## A1/D bootstrap

Integration-owned `runtime.ts` now creates the real Tiger adapter and registers A1 when configuration is complete, with sanitized dependency diagnostics and ordered shutdown. `app.ts` lets installed registrars replace the queue before foundation fallbacks and accepts truthful installed capability flags. `index.ts` uses this runtime; `dev:ml` passes the root server environment to Python. Environment templates and `docs/integration/runtime.md` document startup and independent enrichment.

A read-only bootstrap review found no blocker, including a configured-path stub probe and concurrent shutdown. Twelve focused app/runtime tests passed. An independent call using the canonical ignored environment reached the actual Tiger schema and reported database=true, Spotify=false, ML=false; OAuth returned 503 with exactly `SPOTIFY_ALLOWED_USER_IDS_REQUIRED` in server-side startup diagnostics. Default tests, typecheck, build and foundation HTTP smoke passed. This verifies wiring and a fail-closed missing-owner state, not actual Spotify consent. A1/D's opt-in real DB workflow test remains the controlled-provider persistence proof. Next integration is A's authenticated queue and C1's server adapter.

## Authenticated queue integration — A commits `c10432d` / `cae5db9`

Merged A's completed queue slice after D and runtime bootstrap. Duplicate D ancestry caused add/add conflicts only in four DB test files; retained the current lazy-setup/cloud-timeout fixes. Shared contracts remain unchanged. Independent review found no P0/P1 queue blocker. Root installs `QueueService` with the real repository and supplies the explicit demo handler only when demo is enabled.

Checks pass: **104 default TypeScript tests / 732 assertions**, typecheck, web/API build, foundation HTTP smoke, and two actual-Tiger integration tests with **35 assertions**. The new root `apps/api/test/backend.integration.test.ts` uses a real local HTTP socket and disposable Tiger schema: controlled OAuth response → encrypted account/session persistence → asynchronous three-track import → real DB rows with null audio → authenticated queue → exact durable exposures and foreign-owner rejection. Explicit demo mode still returns synthetic data. Spotify responses are controlled fixtures and no real Spotify request or mutation occurs.

The initial queue uses honest untrained metadata fallback and deterministic ordering. It does not claim ML scoring or learned selection until C1/C2 adapters are installed. Before C1 integration, A is correcting the assembler seam to see the full current library, so artist counts cannot be truncated to a page. Next dependency: C1 API adapter `5230fdd`, followed by combined Tiger + real C1 smoke; A2 mutations and durable feedback transport remain in progress.

## C1 API adapter integration — `5230fdd`

Merged the server-only `apps/api/src/ml/**` adapter without conflicts or changes to the accepted Python service. Independent review found no blocker. Fresh combined checks pass: **209 TypeScript tests / 1,104 assertions** with the real Bun-to-C1 adapter test enabled, **214 Python tests**, typecheck, web/API build, HTTP smoke and unchanged generated schemas. The client validates identities and frozen DTOs, bounds response reading, refuses redirects, and keeps credentials private. The feature assembler handles nullable audio and immutable exposure-time training inputs. Root queue-to-adapter wiring remains the immediate next step.

The user supplied owner username `ram.in`; canonical ignored configuration was updated, and local API/web/ML processes started. Runtime validation exposed an existing shared-ID regex bug: periods are rejected. OAuth remains safely disabled while the integration lead publishes an additive ID-pattern correction and C1 mirrors it in Python. No email is required or stored for owner matching.

## Dotted owner ID correction

The actual owner configuration `ram.in` exposed a restrictive `IdSchema`. A failing regression reproduced rejection at the session and internal scoring boundaries. The integration lead widened the allowed ID alphabet to include periods, retained path/query/whitespace rejection, regenerated all 61 schemas, and verified 32 focused shared-contract/auth tests (184 assertions) plus typecheck. This is additive; field names and contract/feature versions are unchanged. Python's corresponding correction is delegated to C1 and will be integrated before enabling live C1 scoring. API login can now accept the exact owner username. Undo pending and fresh-exposure semantics agreed with A/D/B are documented without changing wire DTOs.

## Tiger → C1 → queue wiring

Integrated A's full-library feature fix `7b54e85` as `826e0ba`, preserving actual primary-artist counts beyond the displayed page. Integrated C1's dotted-ID correction `1111f0c` as `14a592d`; all **228 Python tests** pass (214 existing plus 14 identifier regressions). User storage remains hashed; model filename constraints are unchanged.

Root runtime now assembles permission/provenance-tagged metadata from full current Tiger rows and calls the authenticated C1 adapter. It still returns a durable honest fallback when audio or ML is unavailable. The server metadata basis is configured in the ignored local environment. Fresh verification: **211 TypeScript tests / 1,114 assertions** with the real adapter enabled, typecheck, web/API build, and the combined backend smoke **1 pass / 43 assertions** against actual Tiger + a real temporary C1 process. The smoke includes a dotted controlled owner, actual HTTP OAuth/import, three missing-audio records, persisted predictions matching C1 explanations, user isolation, public demo separation, and ML-outage fallback. `bun run smoke:backend` reproduces it using disposable schema/artifacts and controlled Spotify responses; no real-user data or provider mutation is claimed.

Canonical API/web/ML processes were started locally at ports 3001/5173/8000. After publishing the ID fix, actual API health reports Spotify/database installed and `/api/auth/spotify/start` returns 302 to accounts.spotify.com. The user has the working direct login link. Real consent/import is not yet recorded as verified. B2 final fixes are under review; the first B2 review caught an unrecoverable journal after a known 501 NOT_IMPLEMENTED rejection, delegated back to B. A2 is completing mutation/recovery verification; its read-only sessions will require renewed consent when write scopes land.

## D recovery and feedback persistence — through `b619982`

Merged D's completed feedback outbox, fenced review recovery, exposure consumption guards and latency-safe SoundNet limiter. Independent read-only review found no P0/P1 blocker and passed 15 local PostgreSQL tests / 122 assertions. Root verification on the merged tree passed typecheck, 210 default TypeScript tests / 1,101 assertions, build, foundation HTTP smoke, and **29 actual-Tiger tests / 235 assertions** (one optional 35-second provider-delay test skipped). The Tiger run includes the real C1 backend smoke, durable feedback revisions, stale lease rejection, recovery, concurrent exposure consumption, importer persistence and limiter latency/crash behavior; provider responses remain controlled.

Applied additive migrations 007–009 to the actual application schema successfully; the immediate second run applied nothing, with the telemetry hypertable present. No actual Spotify cleanup or SoundNet request is claimed. A final A2 review found that import publication could overwrite a concurrent confirmed Unlike/Undo. A/D are implementing an approved membership-revision CAS plus a pending destructive-work guard before live mutation capability is enabled; this does not block OAuth, import, scoring or queue integration. Next dependencies are B2's completed UI fix, A's feedback worker, and the coordinated importer revision fence/A2 handoff.

## B2 live frontend integration — through `6cc4adf`

Merged the completed connected frontend after its focused 501 rejection fix. Independent review verified that a first-attempt explicit NOT_IMPLEMENTED rejection releases only the unaccepted command; earlier ambiguous requests retain their journal/key through reload and recovery. Root merged-tree checks passed **229 TypeScript tests / 1,171 assertions**, typecheck, web/API build and foundation HTTP smoke. Public schemas and the accepted C1 source are unchanged.

Default entry now loads the actual account/session, returns from OAuth to import, polls actual import progress and consumes the authenticated scored queue. Explicit demo mode remains isolated. Read-only sessions disable Archive/Unlike; missing mutation/insight endpoints stay explicit. B's browser evidence uses a labeled HTTP fixture; real Spotify consent/import remains a separate gate. The user reported a redirect mismatch in B's chat and was given the exact configured callback `http://127.0.0.1:3001/api/auth/spotify/callback`. Next: verify the running integrated UI and user consent, wire the completed feedback worker, then accept A2 only with the import revision fence.
