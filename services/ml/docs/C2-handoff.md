# C2 integration handoff

This is the historical 0.3.1 handoff. The follow-up snapshot integration protocol
and verification are documented in [C2-protocol-handoff.md](C2-protocol-handoff.md); its v3 decisions
and schema 3 supersede the adapter gate and C1 filtering bypass described below.

Branch `c2-contextual-bandit`, worktree `sort.fm-c2`, approved starting foundation `9dab2fa` (includes C1/A1). Package `0.3.1`. Changes are confined to `services/ml/**`; no merge performed. C1 ENGINE_VERSION/model formats, shared contract `1.0.0` and feature version `sortfm.features.v1` remain unchanged. **Production C2 activation remains disabled.**

## Delivered

Shared-linear LinUCB with Cholesky ridge solves, bounded C1 contexts, configurable exploration, deterministic seeds, epsilon-greedy/random controls, exploration prefix caps, artist constraints with explicit relaxation, obvious-keep protection, bounded reservations and C1 cold/disabled fallback. Authenticated local selection/feedback/release/diagnostic/exposure endpoints preserve C1 prediction DTOs and immutable versions.

Logs retain candidate IDs/full-input hash, chosen features/context, C1 prediction, selection scores, linear uncertainty, design information, seed/config/version, nominal randomized probabilities and feedback/reward. Feedback intents contribute only after C1 commits. Active training-only C1 decisions govern reward fitting; holdout, SKIP, Undo, supersession and full-fit deletion are distinct. Contexts are rebuilt consistently for each selected C1 version.

The current user's utility requirement deliberately supersedes the master spec's deletion-only reward: 75% useful-review rating (or labeled completion proxy), 25% frozen prediction correction; no deletion bonus. Correction and linear-design information are proxies, not realized information gain. Exact behavior and schema proposals: [C2-api.md](C2-api.md).

## Lifecycle follow-up verified November 7, 2026

The integration-reviewed [reservation design](C2-reservation-proposal.md) is now implemented locally in commit `84962b5`. New selections use `c2-linucb-v2`; storage has independent `schemaVersion=2`. Frozen server-clock leases default to 300 seconds, with startup configuration limited to 30–900. Strict authenticated `/policy/release` commits the targeted closure and immutable idempotency receipt atomically. Exposure inspection adds current reservation state and immutable selection-time eligibility metadata. Historical selection replay does not renew a lease. Release/expiry preserves feedback, C1 revisions, rewards, model versions and unrelated exposures.

Migration validates legacy v1 state, derives deadlines from original creation time plus a fixed 300 seconds, reconciles already committed Undo, and preserves original decisions/fingerprints/prediction/version tags. Take a verified complete artifact backup before first use; no automatic pre-migration backup is created, and an old reader requires restoring the backup. Terminal closures survive restart and clock rollback after observation. Corrupt receipts/lifecycle references/audit snapshots fail closed.

- `UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache uv run --offline pytest -q`: **402 passed in 21.07 seconds**. This includes all 308 prior tests plus 47 lifecycle/API tests and 47 migration/recovery/race/integrity tests. Tests use an injected clock and event-controlled concurrency, not TTL sleeps.
- Independent review findings fixed and regression-tested: release replay/conflict/unknown paths must persist newly observed expiries; explicit closures require exactly one primary release receipt; eligibility logs require valid candidate/blocker/history references. Final review found no remaining material correctness issue.
- `uv run --offline python scripts/smoke_policy.py` and `scripts/smoke_ml.py`: **PASS** on real authenticated localhost HTTP, including release/rescheduling, immutable receipt replay, Undo, restart, C1 explanation and typed lifecycle inspection.
- Root `bun run typecheck`: **PASS**. Socket-enabled `bun run test`: **68 passed, 1 skipped**, zero failures. The separate PostgreSQL configuration remains absent. Initial sandboxed execution could not bind localhost; rerunning with socket access passed. `bun run build`: **PASS**, with the same two nonfatal Zod annotation warnings.
- `uv lock --check --offline` and `uv build --offline`: **PASS**. Version changed to 0.3.1; dependency versions did not change.
- Installed the 0.3.1 wheel into a **new Python 3.11.12 virtual environment** at `/tmp/sortfm-c2-lease-wheel.DrRWIP`. Isolated-mode execution from `/tmp` confirmed imports from its `site-packages` and passed selection/release/receipt/reselection/restart/expiry checks against that installed package.
- The installed wheel ran `python -I -m sortfm_ml.simulate --seeds 42 --size 40 --budget 8 --holdout-size 20 --output /tmp/sortfm-c2-lease-wheel-simulation.json`; output was byte-identical to the previously verified 0.3.0 seeded simulator output. The numerical policy and simulator were not changed by this lifecycle patch.
- `git diff --check`: **PASS**. No provider calls, shared contracts, backend feedback adapter, public activation, or database code were changed.

### Follow-up timing measurements

Both measurements use the existing synthetic **2,700 candidates / 100 C1 labels**, five measured repetitions after one excluded warm-up. The ASGI workload has one actual policy reward and real local persistence. Raw samples are retained for both runs:

| Median seconds | During concurrent verification | After repository test/build workload |
|---|---:|---:|
| C1 fit | 0.021752 | 0.011818 |
| C1 predictions | 0.561321 | 0.294620 |
| Candidate contexts | 0.222669 | 0.110772 |
| Policy statistics rebuild | 0.038701 | 0.019959 |
| Numerical selection | 0.060064 | 0.030560 |
| Predictions + contexts + rebuild + selection | 0.859096 | 0.461254 |
| Authenticated ASGI selection with persistence | 1.198770 | 0.625993 |

[First run](../experiments/c2-reservations-benchmark-cpu.json), [later run](../experiments/c2-reservations-benchmark-cpu-sequential.json). The later command ran after the repository checks; the host was not controlled or dedicated. These are actual local measurements, not a matched regression experiment or an SLA. Do not attribute timing differences solely to the lifecycle change. Reproduce with `uv run --offline python scripts/benchmark_bandit.py --size 2700 --training 100 --repeats 5 --seed 42 --output <report.json>`.

## Original C2 verification, package 0.3.0

Commands ran in this worktree using `UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache`, a writable copy of the locked local cache. Initial online dependency install failed due restricted DNS; offline install succeeded with no new dependencies.

- `uv run --offline pytest -q`: **308 passed** on the final package version: 214 C1 + 38 numerical/selector + 35 policy service + 21 simulator/benchmark tests. Finalization rerun: 17.11 seconds, zero failures.
- `uv run --offline python scripts/smoke_policy.py`: PASS real Uvicorn localhost auth, cold fallback, adaptation after KEEP, rating, retries, Undo, restart, immutable C1 explanation and policy logs.
- `uv run --offline python scripts/smoke_ml.py`: PASS unchanged real HTTP C1 smoke; 131 training examples and available synthetic holdout metrics.
- `uv lock --check --offline`, `uv build --offline`: pass, wheel and sdist; dependency versions unchanged.
- Installed `sortfm_ml-0.3.0` wheel in a clean Python 3.11 virtual environment under `/tmp` and ran the C2 simulation CLI from outside the repository: **pass**. Earlier no-project invocations selected unsupported system Python 3.9, then hit a host-installed pandas/NumPy ABI conflict in uv's overlay; a true isolated virtual environment resolved the host conflict. No dependency or source workaround was needed.
- Finalization reran the installed-wheel CLI with Python isolated mode (`-I`) from `/tmp` and verified exact JSON equality with the previous seeded run: **pass**. Confirmed Python 3.11.12, installed package 0.3.0, and import from the clean virtual environment's `site-packages`, not the checkout.
- Root `bun run typecheck`: pass. `bun run test`: **68 passed, 1 skipped**, zero failures. The A1 PostgreSQL integration test lacks its separate database configuration. An initial sandboxed run could not bind localhost; the socket-enabled run passed.
- Root `bun run build`: pass, retaining two pre-existing nonfatal Zod comment-annotation warnings. `git diff --check`: pass.
- Independent review covered numerical math, lifecycle, API, simulator and benchmark. Confirmed findings fixed with failing-then-passing regressions: redo/stale Undo releasing reservations; equivalent null/omitted features dropping active rewards; rejected events poisoning retries. Added C1 nonpolicy observation isolation from C2 corruption. Removed unnecessary full-queue O(N²D) ranking from the learned-policy path. These findings are resolved; the production reservation activation gate below remains.

## Measured results

Three predeclared synthetic worlds (seeds **11,29,47**), **400 candidates**, **80 exposures** per policy, **150 untouched holdout tracks**, all policies initially cold:

| Policy | Cumulative reward mean ± sample SD | Holdout Brier | Holdout log loss |
|---|---:|---:|---:|
| C1 deterministic ranking | 38.9434 ± 2.5789 | 0.2532 | 0.8228 |
| Random | 34.6006 ± 1.3846 | 0.2439 | 0.6978 |
| Epsilon-greedy | 37.8950 ± 2.2314 | 0.2889 | 0.9485 |
| LinUCB | 35.4528 ± 0.8997 | 0.2650 | 1.0076 |

**LinUCB did not beat C1 or epsilon-greedy.** Its paired reward difference from C1 is -3.4906 ± 2.6744 sample SD. Three seeds provide descriptive variation, not confidence intervals or real-listener evidence. Random supplied better Brier/log-loss here despite lower review utility; predictive quality and policy reward are intentionally evaluated separately. No parameters were tuned to these results.

Full [report](../experiments/c2-simulation-seeds11-29-47.md), [every trace/checkpoint and runtime/hash](../experiments/c2-simulation-seeds11-29-47.json), and [method/reproduction commands](C2-evaluation.md) are included.

Five measured local arm64 runs following one excluded warm-up, **2,700 candidates / 100 supervised labels**:

| Stage | Median seconds |
|---|---:|
| C1 fit | 0.010724 |
| C1 predictions with explanations | 0.315736 |
| Candidate contexts | 0.123134 |
| Policy context/statistics rebuild | 0.018236 |
| Numerical selection | 0.034075 |
| Predictions + contexts + rebuild + selection | 0.494481 |
| Authenticated ASGI selection with real local persistence | 0.598634 |

ASGI uses a separate fresh temporary store per run with 100 C1 labels and one actual policy reward. It includes authentication, validation, JSON, checksums, locks and durable writes, but not socket/TLS/deployed concurrency. [Raw benchmark](../experiments/c2-benchmark-cpu.json) records every timing and runtime. No SLA is claimed.

## Integration gates and unverified scope

Read [C2-api.md](C2-api.md) before wiring backend/UI/DB. Shared exposure uncertainty must remain C1 uncertainty; C2 radius/UCB/design gain require separate telemetry. The existing public selection-method enum cannot represent epsilon-greedy/random; only integration may amend it. New C2 routes are explicitly local schema proposals. Backend/public inspector/Tiger Data activation was neither changed nor tested by this workstream.

The service-local reservation blocker is resolved, but **activation still requires a coherent feedback adapter**. A2 `FeedbackWorker` currently sends `/fit` snapshots, not `/policy/feedback` events. Those snapshots cannot establish committed C2 reward/history. Do not bolt `/observe` beside `/fit` at the same revision; root/A/C2 must design one consistent transport before activation. Backend candidate pools must exclude pending review/Undo tracks **and settled reviews awaiting ML synchronization**. Expiry/release cannot establish database eligibility or cancel a mutation. Before serving an expired/released selection replay, inspect lifecycle and database eligibility; new scheduling requires a new exposure ID. These gates and provider/database integration remain untouched.

Integration sequence: preserve the canonical identifier fix when merging this local branch; back up complete ML artifacts before enabling the new reader; use one replica with trusted durable POSIX storage; adopt the internal schemas explicitly; keep production policy activation off until transport, eligibility/replay and public telemetry are validated. C1 deterministic ranking remains available without reservation filtering. The separately coordinated period-in-user-ID amendment remains with foundation/C1; C2 did not edit that shared/mirrored pattern.

Keep C2 experimental pending prospective validation. Actual Spotify/SoundNet data, human ratings, production deployment, long-term fatigue, distributed persistence, catastrophic kill recovery and retention/compaction are unverified. Synthetic counterfactual outcomes do not establish unbiased off-policy improvement. Adaptive supervised representations and selection constraints do not justify a formal LinUCB regret bound.

Final disposition: C2 is finalized locally per the user's explicit instruction. Keep `c2-contextual-bandit` unmerged in `sort.fm-c2`; the integration lead will integrate the local branch directly. No GitHub push is necessary or authorized, and no merge was performed by C2. The earlier rejected publication attempt is resolved by this local handoff, not an outstanding blocker or approval request.
