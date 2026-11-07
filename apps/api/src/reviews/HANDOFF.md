# A2 queue slice

Depends on foundation `fd5aba2` and D `a910173` (locally cherry-picked as `d6ab6c0`). No root runtime, DB or shared-contract files changed by this slice.

## Wiring (integration lead)

```ts
const queue = new QueueService(repository, {
  assemble: (rows, context) => assembleLibraryCandidates(rows, {
    ...context,
    now: new Date(context.now).toISOString(),
    metadataTraining: configuredMetadataTrainingRights,
  }),
  score: (userId, candidates, modelVersion) => repositoryMl.score(userId, candidates, modelVersion),
});
const reviews = createReviewQueueModule({queue, auth: spotify.auth, config});
await reviews.registerRoutes(app);
```

Both assembler and scorer are optional. The built-in metadata snapshot does not infer training permission. C1 supplies assembly/scoring; root config supplies the explicit rights basis. Queue uses the server-resolved session account only. Register before any queue fallback. This registrar owns only `GET /api/queue`. Root may inject `demoQueue(query) => createDemoQueue(...)` to retain explicit `?mode=demo` without session access; missing callback returns 404 DEMO_DISABLED. The separate demo bootstrap remains root-owned.

Queue reads D's current membership, selects playable saved/deferred Spotify tracks, excludes in-flight decisions, puts deferred tracks last, and persists each exact feature/prediction/exposure snapshot before returning it. Scoring has a 2-second deadline; failures never leak upstream text. Fallback rotates exposure IDs so late scoring cannot contradict a served baseline; scorer inputs are cloned. Every request gets new exposure IDs. No cursor is advertised because the frozen query contract has no cursor input: subsequent reads derive eligibility from durable decisions.

Selection now uses C1 learned removal probabilities when available; see the adaptive ranking section below. Cold start uses `deterministic_baseline` with null probabilities. SoundNet completion is never required. `remaining` is eligible tracks before selecting the page.

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


## Adaptive C1 queue ranking (P0)

Base: canonical foundation `d4bb8b3`; isolated branch `a1-c1-adaptive-queue`. Changes are limited to `queue.ts`, focused queue tests and this handoff. Runtime, shared contracts, ML implementation, DB and provider writes are unchanged.

The queue assembles context from the entire current Spotify library, then scores every eligible track **without exposure IDs**. Learned C1 logistic probabilities order saved tracks first, deferred tracks second, descending removal probability within each group. Exact ties retain original-added-at then track-ID order. Only the selected page receives exposure IDs and a second score call pinned to the first pass's `modelVersion`. Responses must preserve owner, exact track set, model identity, trained count and predictions; only numeric roundoff up to `1e-12` is allowed between pool and keyed predictions. The keyed response is the exact persisted/served snapshot. No queue read fetches feedback, fits a model or writes to Spotify.

The integration root **must forward the optional third `modelVersion` argument** shown above. A two-argument callback is still TypeScript-compatible but cannot guarantee pinning if a new model is published between calls; the queue detects that mismatch and safely falls back. No shared contract change is necessary.

Actual learned selection is `logistic_rank`, policy version `queue:c1-removal:v1`, exploration coefficient0 and propensitynull. Requested balanced/discovery/certainty is preserved; discovery/certainty explicitly report that C1 removal ranking is being used and policy-specific exploration is absent. C2 remains separate. Heuristic/cold scores never become removal probabilities and preserve stable ordering with an explicit reason. Non-C1 model families fail safely until their ranking policy is integrated.

Both calls share one monotonic 2,000ms scoring deadline (configurable). Timeout, incomplete/foreign/mixed responses, model mismatch or changed predictions restore stable order with entirely fresh baseline IDs and immutable feature snapshots. Late keyed calls may persist orphan observations but can never change served fallback identities. The deadline bounds scoring, not repository reads/persistence or an event-loop stall. Pools above the frozen contract's10,000-candidate limit explicitly use stable fallback; no prefix is silently treated as the complete library.

Consistency boundary: automatic feedback training is asynchronous. Queue reads use the latest committed actual C1 model at the first score call, without waiting for a worker. A page stays pinned if a fit publishes between passes; the next read can use that newer model. Successful review/Undo refresh and post-manual-fit refresh are owned by B/root. Existing exposures and explanations are never rewritten after retraining.

### Verification and realistic timing

- `bun test apps/api/src/reviews/queue.test.ts`:19 pass,96 assertions. Includes whole-pool ranking before slicing, eligibility/deferred grouping, deterministic ties, model changes, cold scores, owner/version/prediction coherence, floating-point tolerance, total deadline and safe late-response fallback.
- `QUEUE_RANKING_INTEGRATION=1 bun test apps/api/src/reviews/queue-ranking.integration.test.ts`:1 pass,59 assertions against a real isolated FastAPI/C1 process, generated fixtures only. No provider or live database access.
- The real integration fits48 training examples, changes the authoritative feedback snapshot and fits a second model. Top served track changes from fixture2768 to fixture1. A deliberately concurrent publication between passes preserves the old model's selected order/version. Old cold and learned explanations remain exact; foreign-owner explain fails.
- Six full2768-track queue reads (20-card pages):312ms cold,496ms learned,515ms with publication between passes,380ms new model,429/452ms warm. Pool HTTP scoring271–461ms; selected keyed scoring8–33ms. These are local observations with an in-memory repository, **not end-to-end production DB latency or a service-level guarantee**. Real exposure storage contains exactly120 served records, not16,608 unserved alternatives. All audio features remain missing.
- Module regression: `bun test apps/api/src/reviews apps/api/src/ml` →249 pass,6 opt-in skips,0 fail,1256 assertions. The new real integration skip was run explicitly above. Other existing DB/provider integration tests were not rerun for this change.
- `bun run typecheck`, `bun run build`, standalone reviews module Bun bundle and `git diff --check`:passed. Independent read-only review found no actionable defects.

No module blocker remains. Runtime callback wiring and canonical integration belong to the lead. C2 exploration and production latency/provider smoke remain outside this change.
