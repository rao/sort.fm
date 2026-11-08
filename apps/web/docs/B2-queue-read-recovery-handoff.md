# B2 queue read recovery

Branch: b2-queue-read-recovery. Base: approved foundation 2679000. Scope: apps/web only; no provider, database, deployment or live-user operation.

`createLiveApi.queue()` now uses the existing read helper, keyed by the shared schema's normalized complete query. Equivalent simultaneous GETs share one request and one retry budget. Different limit, policy and mode queries remain separate; completed/failed reads are removed, not cached. Only typed retryable API errors receive one automatic retry. Authentication/authorization, raw transport failures and malformed success responses are not retried. All writes and command journals are unchanged.

Companion API commit: A1 4fe44ccfa646fc7e8d632bdd910f7e5aef287c7d returns 503 QUEUE_PREPARING with retryable:true after its 12-second whole-operation wait, while durable work continues and identical retries join it. Browser requests remain bounded individually at 20 seconds. After the one retry, the existing initial-load error / Retry workspace and refresh-error controls provide manual recovery; no new UI state or DTO is needed.

Tests reproduce the prior duplicate GET and missing retry, then verify normalization, query separation, exactly one shared retry, typed failure preservation, manual read recovery, retained unfinished commands, and no automatic write replay. Nine focused tests pass with 29 assertions. Full suite: 1036 passed, 188 environment-gated skips, zero failures, 5579 assertions. Root typecheck, web lint (76 files), production web/API builds, foundation HTTP smoke and diff check pass. No real-service acceptance claimed.

Changed files: src/data/live-client.ts (five-line integration), src/data/queue-read.test.ts (regressions), this handoff. Integration lead should cherry-pick this focused commit together with the A1 deadline fix and rerun A1's policy timeout HTTP/browser tests on the combined tree. No main/foundation merge performed by B2.
