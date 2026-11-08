# C2 API integration handoff

A owns API orchestration only. Root owns configuration/runtime/activation and shared contracts; D owns the actual persistence adapter and settlement outbox; C2 owns the ML service. C1 remains the production default. This branch performs no provider calls, production database operations, migrations or activation.

## Dependencies

Approved root commits: telemetry `3a77223`, wire protocol `3112c89`, persistence ports `1bdf86e`, immutable queue preference/committed Skip closure `ef4ee0a`, and clock/revision validation `9a0fdd2`. Their cherry-picked equivalents are dependencies, not A-authored changes. The API uses the exported contracts without local DTO replacements.

## Composition

- `createPolicyClient` from `apps/api/src/ml` takes the same server-only `MlClientOptions` as `createMlClient`. It exposes `select`, `exposure`, `release`, `associate`; never fit/observe. Use only backend ML URL/shared secret configuration. Timeout includes response body parsing, redirects are refused, errors are sanitized, and each method makes one attempt.
- `PolicyQueueService` from this directory takes `Pick<PolicyStore, 'currentSelection' | 'reviewCandidates' | 'prepareSelection' | 'publishSelection' | 'releaseSelection'>` and `PolicyQueueOptions`. Pass the existing C1 `assemble`/`score` callbacks. Defaults are C1, disabled adaptive selection, 15-second selection deadline, 60-second execution lease, and five-minute fixed reservation. Root must explicitly inject `enabled:true`, `strategy:'epsilon_greedy'|'linucb'`, and the private client to select adaptively. `config` may override C2 tuning parameters; `seed` defaults to 42.
- `createReviewQueueModule` accepts the public `get` method, so either legacy or policy-aware queue fits existing authentication and strict query validation. Browser `policy=balanced|discovery|certainty` remains a preference; it cannot switch the server algorithm.
- `PolicyDeliveryWorker(store, client, options)` independently drains `claimPolicyDelivery`/ack/retry. Default delivery timeout 45 seconds, lease 120 seconds, retry 30 seconds, poll five seconds. It validates identities and receipts even for injected transports. A stale-fit response is durably retried; the next claim supplies D's newest receipt. It never calls fit or observe.
- `PolicySelectionRecoveryWorker(store, client, options)` drains `claimSelectionRecovery` and repeats the exact persisted request, including full feature/config/model/revision inputs and public queue preference. Defaults are 15-second attempt, 60-second lease, five-second poll. Recovered publications become available through `currentSelection`; expired/failed attempts use fenced abandonment.
- Both workers expose `start()`, `kick()`, `runOnce()` and asynchronous `close()`. Root starts/closes them through the existing server lifecycle. Safe `onError` callbacks receive fixed codes, not provider bodies or credentials.
- Existing `FeedbackWorker` now passes its validated `FitResponse` as the fourth optional argument of `acknowledgeFeedbackSync`. D persists the actual model/revision receipt atomically with acknowledgement. Existing three-argument implementations remain source-compatible. Root separately wires `recordPolicyFitReceipt` inside actual shared fit completion so a manual HTTP timeout cannot lose a later successful fit receipt. Policy availability must not gate C1 training.

## Queue and recovery semantics

All new selections and replays use D's common membership, pending review/Undo, active feedback, permanent Batch2 and reservation eligibility rules. API feature context uses the entire confirmed current library; only eligible IDs enter selection. D rechecks eligibility under the publication lock even when revision counters have not changed.

C1 retains multi-card ranking and atomic page publication, with no C2 network requirement. Adaptive requests select one card, even when the requested limit is twenty. The exact request is stored before ML I/O; selected features, owner, exposure, model/revision, config and candidate identities are checked before publication. Inspection must return the same decision and an active bounded reservation. C1 probability and uncertainty remain distinct from C2 score and radius.

GET reuses only `servableExposureIds` of the current immutable publication. A server algorithm switch releases incompatible prefetch before selecting again. C1 fallback pages use `queue:c1-fallback:<strategy>:v1` policy versions so repeated GETs can reuse the fallback instead of allocating another page. This is scheduling provenance, not a new classifier version. On policy failure, the queue abandons the attempted exposure under its execution fence, rereads eligibility, and creates fresh unbound C1 IDs. A stale publication rejection cannot be returned to the browser.

The entire queue operation has a separate 12-second HTTP wait budget (`requestTimeoutMs`, positive integer up to 15 seconds), leaving headroom under the browser's 20-second transport limit. This includes current-publication reads, incompatible prefetch release, candidate loading, preparation and publication. Expiry returns the existing error envelope with `QUEUE_PREPARING`, HTTP 503 and `retryable:true`. It does **not** cancel selection, abandon reservations or trigger fallback. Identical owner/query retries join the same in-process operation; a different query for that owner receives retryable `POLICY_SELECTION_BUSY`. Completed results are never cached: the next request checks persisted eligibility. Durable fencing and recovery remain authoritative across processes/restarts. Authentication happens before this budget, so authentication/transport latency still requires its own operational monitoring.

The existing browser client surfaces this typed error for queue reads; manual Retry workspace joins ongoing work or replays its durable publication. Browser automatic retry is a separate B-owned integration. Synthetic tests cover a 2,397-candidate strategy switch with 20 C1 cards, ordinary delayed publication through Fastify and the browser client, owner isolation, late failures, concurrent retry deduplication, and consumed-card replacement. These tests do not establish live database/ML latency or perform real-account operations.

Background recovery replays exact requests, never recomputes features/model/config from current state, and cannot renew issuance deadlines. Abandonment uses a stable release command ID per intent/lease. D rejects stale fences and keeps published outcomes safe from older cleanup attempts.

## Feedback and release semantics

Only D's committed cleanup settlement emits association/revoke events for actual policy-bound review exposures. Calibration, pending/failed reviews, pending Undo and historical/default/fallback C1 exposures must never enter this outbox. The worker validates this transport boundary but cannot infer database settlement from arbitrary caller data; there is no public enqueue route.

Immutable association event identity and source revision are separate from the refreshable current fit receipt. Historical events coalesced out of a newer fit can be recorded without active reward. Skip, Undo and unpermitted features cannot receive an eligible-for-learning receipt. A late revoke targets its original exposure only.

Release404 is not closure. The worker performs a fresh exact exposure inspection; only a second typed404 can be offered to D as `release_absent`. D must additionally enforce unpublished intent, original fixed deadline plus sixty-second grace and current live lease. That disposition is local absence, never a fabricated provider release receipt. A very late remote commit can leave a bounded ghost reservation; it must not be served or rewarded. Published exposures require actual release/expiry evidence.

## Verification scope and remaining integration gates

API tests exercise injected transports and persistence ports: all strategies, frozen identity, separate telemetry, default/disabled/missing-receipt fallback, exact recovery, current-page replay, policy switches, stale publication, malformed/expired leases, release404 reconciliation, coalesced events, advanced receipts, response loss, timeouts, shutdown and logging failures. Existing C1 client/queue tests remain regression coverage.

Root/D/C2 still own cross-service acceptance against actual disposable PostgreSQL and the updated Python service, optional migration capability handling, shared fit-completion receipt persistence, runtime configuration/lifecycle and deployment readiness. Passing mocked API tests alone is not controlled real-account pilot approval. Live account behavior is untested here; public activation stays off.


Final local verification: `bun test` — 803 passed, 127 environment-gated skips, 0 failed, 4,382 assertions. `bun run typecheck` and `bun run build` passed. A direct Bun build of this policy module also passed. Independent review's C1 stale-receipt coupling and incorrect ordering message were fixed with failing-then-passing regressions; no review findings remain deferred. Cross-service/live acceptance remains explicitly unverified here.
