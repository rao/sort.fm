# A2 queue slice

Depends on foundation `fd5aba2` and D `a910173` (locally cherry-picked as `d6ab6c0`). No root runtime, DB or shared-contract files changed by this slice.

## Wiring (integration lead)

```ts
const queue = new QueueService(repository, {
  assemble: (rows, context) => assembleLibraryCandidates(rows, {
    ...context,
    metadataTraining: configuredMetadataTrainingRights,
  }),
  score: (userId, candidates) => repositoryMl.score(userId, candidates),
});
const reviews = createReviewQueueModule({queue, auth: spotify.auth, config});
await reviews.registerRoutes(app);
```

Both assembler and scorer are optional. The built-in metadata snapshot does not infer training permission. C1 supplies assembly/scoring; root config supplies the explicit rights basis. Queue uses the server-resolved session account only. Register before any queue fallback. This registrar owns only `GET /api/queue`. Root may inject `demoQueue(query) => createDemoQueue(...)` to retain explicit `?mode=demo` without session access; missing callback returns 404 DEMO_DISABLED. The separate demo bootstrap remains root-owned.

Queue reads D's current membership, selects playable saved/deferred Spotify tracks, excludes in-flight decisions, puts deferred tracks last, and persists each exact feature/prediction/exposure snapshot before returning it. Scoring has a 2-second deadline; failures never leak upstream text. Fallback rotates exposure IDs so late scoring cannot contradict a served baseline; scorer inputs are cloned. Every request gets new exposure IDs. No cursor is advertised because the frozen query contract has no cursor input: subsequent reads derive eligibility from durable decisions.

Selection is honestly `deterministic_baseline` for all requested policies until C2's selector is integrated. ML predictions can be shown without falsely claiming learned selection. Cold start probabilities are null. SoundNet completion is never required. `remaining` is eligible tracks before selecting the page.

## Verification

- A1 + queue tests: 51 pass, 2 opt-in DB skips, 515 assertions before the review fix; targeted queue rerun after the fix: 8 pass, 35 assertions.
- Separate live Tiger Data isolated-schema queue test: 1 pass, 7 assertions; exact snapshots survive repository reconstruction, foreign user cannot fetch exposure, immutable conflict rejected. Synthetic fixture only; no user tracks changed.
- `bun run typecheck`, `bun run build`, standalone reviews module Bun build: passed.

Independent code review found and verified the late-scoring identity fix; no outstanding findings.

## Live verification gate

Decision/history/Undo and durable feedback delivery are implemented below. Controlled real-track Spotify mutation checks remain unperformed; the integration lead coordinates the owner account smoke.

## Durable feedback transport

`new FeedbackWorker(repository, repositoryMl)` uses D migration 007 / `c98ec4e` and C1 API adapter `5230fdd`. Register `start()` on Fastify ready and `close()` on close. Optional `kick()` after a decision reduces latency; correctness comes from periodic durable claims, not the kick. It fits the authoritative frozen training snapshot, verifies the response owner/revision, and acknowledges that actual revision. Failures and timeouts schedule durable retry. No `/observe` is sent for the same revision.

Validated with an isolated live Tiger schema plus a real FastAPI process: Keep settlement → reconstruct worker → fit/ack revision1, then Undo → reconstruct worker → fit/ack revision2 with zero active labels. Ten assertions passed. Four transport unit tests verify newer-snapshot acknowledgement, rejected stale/cross-user results, timeout, retry, and shutdown. No real Spotify state was touched.

Queue feature assembly now uses the full distinct current Spotify library before page selection, preserving artist counts across kept/deferred/unplayable tracks. Ten queue tests / 42 assertions pass.

## Mutation workflow

```ts
const spotifyWrites = new SpotifyMutations(spotify.auth, spotify.auth.http);
const reviewWorker = new ReviewWorker(repository, spotifyWrites, {
  auth: spotify.auth,
  feedback: feedbackWorker,
});
const reviewService = new ReviewService(repository, {
  auth: spotify.auth,
  worker: reviewWorker,
});
const mutationRoutes = createReviewMutationModule({
  auth: spotify.auth, config, service: reviewService, worker: reviewWorker,
  enableWrites: () => spotify.auth.enableReviewWrites(),
});
await mutationRoutes.registerRoutes(app);
```

Requires D recovery `641b7ad` and exposure guards `bd39926` (migrations008–009), plus root shared fence `3143ef4`, D fence `8ba63f7` / migration010, and the A1 importer fence in this branch. Root owns fallback ordering and health capabilities. Registrar owns decision/history/Undo routes and worker lifecycle. It enables write consent only when installed; existing read-only sessions stay `spotifyWrite:false` until reconnect. Required new scopes are user-library-modify, playlist-modify-private, playlist-read-private.

Decision POST returns persisted PENDING with202, never optimistic completion. The per-user durable lease serializes initial/recovery execution. Keep emits0; Skip emits no strong label; confirmed Archive/Unlike emit1. Archive creates/reuses a private owner playlist, confirms insertion before unlike, and journals non-idempotent POST intents. Timeout/5xx remains uncertain; recovery reads state and never blindly repeats the POST. A definitive429 permits retry after its deadline. Ambiguous absent playlist effects remain pending reconciliation, possibly requiring operator resolution; duplicate writes are not traded for liveness.

Undo persists a command and returns409 `UNDO_PENDING` with retryable:true until confirmed; repeat the SAME idempotency key. Original COMPLETE/label remains authoritative until UNDONE. Destructive Undo re-saves and confirms saved state, revokes the label, and retains the archive copy. Spotify cannot guarantee restoration of the original saved timestamp; DB retains the original snapshot.

Authorization loss after possible remote effects remains FAILED_RETRYABLE so reconnect can reconcile and regain Undo. No tokens, credentials or provider response bodies are exposed.

Current Spotify references verified Nov7,2026: [library save](https://developer.spotify.com/documentation/web-api/reference/save-library-items), [library remove](https://developer.spotify.com/documentation/web-api/reference/remove-library-items), [contains](https://developer.spotify.com/documentation/web-api/reference/check-library-contains), [playlist creation](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [playlist items](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist).

Validation: live Tiger HTTP workflow49assertions covers Keep/Skip, archive-success/unlike-failure/restart without duplicate insert, unlike, same-key repeated decisions/Undo, labels and events. Three live integration tests together passed66assertions (queue,feedback,workflow). Provider is controlled synthetic HTTP; no real Spotify mutation or real-user smoke is claimed. Independent review found and verified malformed reconciliation and authorization-recovery fixes. The discovered stale-import race is addressed by the membership revision fence: importer captures before scanning, discards stale/legacy partial scans, and final DB publication compares revisions while blocking pending destructive review/Undo. Enable this workflow only with all fence components installed together.

Final fence validation passed on live Tiger Data:14 assertions reproduce concurrent unlike and Undo during final import verification/context, reject stale publication, preserve membership/counts and finish a fresh rescan. Existing A1 database workflow13 assertions passed too. Full Bun suite235pass/55opt-in skips/0fail (1230 assertions), typecheck, full build and independent module bundles pass. Real provider smoke remains the external verification gate; all live DB tests used synthetic fixtures in isolated schemas cleaned afterward.

## A2 follow-up verification and archive safety hardening — November 7, 2026

Branch `a2-cleanup-hardening`, isolated worktree `sort.fm-a2`, based on approved integrated foundation `d6d55b4`. The complete mutation workflow above already existed in that foundation. This follow-up audits and tests that implementation and fixes a concrete reconciliation gap; it does not replace the module or change shared contracts. Integration lead owns merging and deployment. No frontend, persistence implementation, shared DTO, or root runtime files changed.

### Fix and changed files

- `apps/api/src/spotify/mutations.ts`: verify that a playlist response identifies the requested playlist. Validate item IDs, URI/type agreement and supplied relinked identity fields before interpreting membership. Reject bare IDs with no resolved item type, empty identities and contradictory metadata. Episodes never confirm a track backup. Malformed state remains retryable instead of becoming evidence of absence or successful archive insertion.
- `apps/api/src/spotify/mutations.test.ts`: regressions for these failures plus valid URI-only, current/legacy, relinked, null and local items. The safety regressions were observed failing before the corresponding fixes.
- `apps/api/src/reviews/worker.test.ts`: archive create/add rejection, ambiguous create/delete/restore, missing archive visibility, rate-limit deadline persistence, database settlement interruption, and Keep/Skip Undo coverage.
- `apps/api/src/reviews/module.test.ts`: all three public review endpoints reject invalid/expired/duplicate sessions, cross-site mutation requests and forged identity fields; pending replay stays HTTP 202 and cross-account history/Undo remain isolated.
- `apps/api/src/reviews/A2-VERIFICATION-PLAN.md`: scoped acceptance and review record.
- `apps/api/src/reviews/HANDOFF.md`: this integration evidence and limitations.

Spotify reference checks: [playlist item identities](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items), [archive insertion](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist), [library removal](https://developer.spotify.com/documentation/web-api/reference/remove-library-items). These documentation checks are not live transaction proof.

### Verified behavior

| Command | Confirmed behavior |
| --- | --- |
| KEEP | No Spotify write; active removal-preference label 0. Undo clears review state and revokes feedback. |
| ARCHIVE | Private owner archive verified; insertion must be observable before unlike. Only confirmed unlike activates label 1. Failed/uncertain archive work never removes the like. |
| SKIP | Deferred; no strong label. Undo clears deferral without Spotify writes or an opposite label. |
| UNLIKE | Explicit command removes directly without archive. Ambiguous completion reconciles saved state before activating label 1. |
| Undo | Original completed decision/label remains until restoration is confirmed. Then local membership is restored and the original label is revoked with a new feedback revision; no opposite example is added. |

Retry keys preserve command identity. Exposure consumption, current-decision guards, owner leases and immutable playlist intents prevent duplicate requests from causing duplicate actions. The feedback outbox delivers authoritative revision-consistent snapshots to C1, including zero labels after Undo. Original exposure predictions remain immutable. Imported saved timestamps remain stored; Spotify's saved ordering cannot be restored exactly. Archive Undo retains the playlist copy, as specified by the shared P0 contract.

### Fresh verification in this worktree

- `bun install --frozen-lockfile`: pass, no lockfile changes.
- `bun run test`: **281 pass, 56 opt-in skips, 0 failures; 1,451 assertions**.
- `bun run typecheck`, `bun run build`, `git diff --check`: pass. Build retains two existing upstream Zod annotation warnings.
- `bun run test:ml`: **228 passed**.
- `bun run smoke`: pass, controlled local HTTP only.
- Targeted adapter/worker/mutation-route tests: **36 pass, 165 assertions**.
- Actual Tiger Data, isolated synthetic schemas: queue snapshot persistence and authenticated workflow both pass (7 and 49 assertions). Workflow covers all actions, archive-success/unlike-failure/restart, repeated commands, destructive Undo and events. Spotify transport was mocked throughout.
- Actual Tiger Data plus local C1 process and durable recovery: **6 pass, 184 assertions** across the full backend HTTP flow, four repository lease/journal recovery cases, and feedback outbox reconstruction/Undo. This includes automatic workers, all four actions and all four Undo actions, model acknowledgement, unchanged exposure predictions, and ML outage fallback.
- Final-code full backend replay plus Tiger decision guards, feedback outbox and settlement atomicity: **7 pass, 168 assertions**. Concurrent distinct request keys consume one exposure once; membership/count settlement is idempotent; stale acknowledgements cannot clear newer feedback; failed settlement rolls back the feedback job and revision together.

An initial new-worktree ML readiness attempt failed before the local service became available. After `uv sync --locked --directory services/ml`, the feedback and full backend checks passed. Initial sandboxed baseline HTTP tests could not bind loopback sockets; those passed when rerun with socket access. Neither failure was hidden or disabled.

Independent read-only review identified remaining bare-ID and contradictory `linked_from` cases. Three additional reproductions failed before the fix and passed afterward; the final full suite passed. No review findings remain deferred.

### Remaining integration gates and recovery limits

No live Spotify transaction, real owner-track mutation, production deployment, or frontend behavior was performed or verified by this follow-up. The integration lead must run the controlled owner-track Keep/Skip/Archive→Undo/Unlike→Undo smoke and confirm provider state plus database events before claiming live acceptance.

An ambiguous non-idempotent playlist POST with no subsequently observable effect deliberately remains unresolved and retryable. Spotify supplies no request idempotency key for that POST, so replaying it blindly could create duplicates. Operator reconciliation may be needed; do not clear durable intents or force a successful result. This is an existing documented recovery limitation, not a new wire-contract change.
