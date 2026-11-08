# API policy integration implementation ledger

Base: foundation `4a9face`; isolated branch `a1-c2-policy`. Root's implementation plan is `docs/superpowers/plans/2026-11-08-c2-integration.md`; architectural boundary notes are in `INTEGRATION.md` here.

## Ownership and decisions

- API client, queue orchestration, independent policy delivery/recovery workers and their tests only. Root owns shared types, server environment, runtime composition and activation. D owns persistence. C2 owns ML behavior.
- Preserve C1 production default. No live provider calls, production database access, deployment or flag activation.
- Consume shared contract commits before binding transport or repository DTOs. Do not invent substitute shared exports.
- Ruling: keep this implementation ledger in the owned API directory rather than root-owned docs; it records API-only progress.

## Task 1: Private transport

Await frozen select/associate/release/inspection contracts. Write failing tests for authenticated exact requests, schema validation, matching owner/exposure/track/model/revision, immutable candidate identity, bounded header/body timeout, sanitized upstream errors and no implicit retries. Implement using established ML client transport conventions without dependencies. A retry must retain the exact select request or event identity; current fit receipt may advance only in the association envelope.

## Task 2: Independent delivery and recovery

Await D's frozen lease ports. Write failing tests for event replay after response loss, sufficient fit receipt, stale receipt renewal, lease loss, interrupted acknowledgement, ordered owner delivery, terminal/durable retry handling and shutdown. Recovery repeats exact persisted selection requests, inspects their lifecycle, and releases unpublishable results with stable identities. An unknown release target is not proof a delayed select cannot commit. Neither worker invokes fit or observe.

## Task 3: Queue orchestration

Await D's atomic page publication contract. Test all three strategies with the same repository eligibility fixture. Assemble context from full confirmed current library but select only eligible IDs. Persist intents before remote selection. Pin actual C1 model/revision and validate response against immutable request. Adaptive requests return one selected item even when the requested limit is larger; C1 pages retain their existing size. Publish only an entirely validated page under D's owner lock; recheck eligibility even when revision counters match. On policy outage or capability absence use fresh, unbound C1 fallback exposures through the same eligibility/publication gate. Verify timeout/late-response races, concurrent queue reads, permanent assignments, pending actions, reservation expiry and truthful telemetry.

## Task 4: Fit receipt integration and route seam

Consume D's validated-fit acknowledgement contract and extend FeedbackWorker to persist the exact returned receipt without coupling C1 progress to policy work. Preserve existing automatic full-fit behavior. Let route injection depend on the queue's public get method so either implementation fits without changing route security. Root composes manual-fit receipt handling and runtime configuration.

## Task 5: Verification and handoff

Run focused API tests, full Bun suite, typecheck and build. Obtain independent review; fix material issues with regression tests. Commit only API-owned changes. Report contract dependency commits separately, exact verification, integration instructions and untested live behavior. Root performs merge and cross-service acceptance.

## Evidence

- Baseline frozen installation succeeded; Bun suite: 736 pass, 127 environment-gated skips, 0 fail, 4,004 assertions. Typecheck passed.
- Root authorized telemetry dependency `3a77223`, consumed as `7cb92b2`; no local changes to root-owned files.
- Internal wire and persistence contracts remain pending. No production implementation claims yet.

- Task 4 route seam: structural queue injection initially failed typecheck (private QueueService fields required). Narrowed to its public get method; security and server-only algorithm control covered by focused route test. Remaining receipt work awaits D contract.
- Independent review added late/manual fit receipt recovery, monotonic receipt pointer, same-revision SKIP order, and recovery-versus-stale-release races to final acceptance. Shared with root.

- Task 1 transport complete: consumed approved wire commit `3112c89` as `2cebce6`. Association tests first failed for missing adapter; selection/lifecycle tests then failed for absent methods; all passed after implementation. Skip/Undo false reward and policy error classification regressions observed red then green. Client suite 168 pass / 680 assertions; full suite 757 pass / 127 skipped / 0 fail / 4,120 assertions; typecheck and web/API build passed. No live ML behavior claimed.
- Consumed frozen persistence `1bdf86e` as `41151f9`, then queue preference/Skip closure `ef4ee0a` as `2675653`.
- Task 2 delivery implementation delegated to an isolated file owner in this worktree; only delivery.ts/test. Fifteen tests cover lease/delivery/retry boundaries including stale fit receipt with a new claim. Main agent inspected implementation and reran focused tests.
- Task 3 queue and selection implemented after missing-module red tests; current page reuse, all three policies, one-item adaptive selection, common eligibility, exact intent/pin/inspection, fenced abandonment and fresh C1 fallback covered. Recovery tests also observed missing-module red before implementation.
- Task 4 feedback acknowledgement now carries validated full FitResponse; old numeric-only expectation changed first, failed, then passed. Manual shared-fit completion hook remains root-owned runtime wiring.
- Recovery database-hang/logging regression observed red then passed with bounded publication and safe diagnostics. Stable abandonment-ID regression observed red then passed using a deterministic per-intent/lease UUID.
- Ruling: a C1 fallback page records policyVersion queue:c1-fallback:<configured-strategy>:v1, leaving modelVersion/prediction unchanged. This lets currentSelection reuse the fallback under the same server configuration; without it every refresh could discard useful prefetched cards. Root notified through handoff.
- Final independent whole-API review dispatched to a fresh reviewer. Root contract/runtime and actual D/C2 acceptance remain outside this branch's ownership.
- Final independent review found optional receipt incorrectly pinning C1's initial score pass. Fixed with red→green regressions for default C1 and fallback: initial null discovers current C1, second pass pins its response. Policy receipt remains required only for adaptive selection.
- Review classified the adaptive/null-probability stable-order message as minor. Ruling: treat false user-facing ordering claims as material correctness, fix in this pass; red→green test confirms adaptive results never claim stable metadata order. No deferred review findings.
- Added passing boundary coverage for concurrent in-progress prepare, prepare replay, and committed publication response loss followed by stale fenced abandonment and next-GET recovery. Actual fence enforcement remains D integration acceptance.
- Root amendment `9a0fdd2` consumed as `aa3a657`. Three clock rollback API assumptions failed regressions then passed after respecting original expiry and terminal state. Already-closed receipt chronology may move backward; fresh released receipts retain chronology checks. Focused client correction committed separately as `9226b0b` for root integration.

- Tasks 1–4 complete within A ownership. Task 5 final evidence: 803 pass / 127 environment-gated skip / 0 fail / 4,382 assertions; typecheck, root web/API build, direct policy module build, and diff whitespace check pass. Independent review findings fixed with regression evidence; no deferred minors. Root owns remaining actual D/C2 integration, runtime receipt hook/config/lifecycle and pilot activation decisions.
- Ruling: follow the user's explicit no-merge/integration-lead instructions and preserve the named feature branch/worktree; no finishing-skill menu or redundant approval request.
