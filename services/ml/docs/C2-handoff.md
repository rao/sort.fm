# C2 integration handoff

Branch `c2-contextual-bandit`, worktree `sort.fm-c2`, approved starting foundation `9dab2fa` (includes C1/A1). Package `0.3.0`. Changes are confined to `services/ml/**`; no merge performed. C1 ENGINE_VERSION/model formats, shared contract `1.0.0` and feature version `sortfm.features.v1` remain unchanged.

## Delivered

Shared-linear LinUCB with Cholesky ridge solves, bounded C1 contexts, configurable exploration, deterministic seeds, epsilon-greedy/random controls, exploration prefix caps, artist constraints with explicit relaxation, obvious-keep protection, no-repeat reservations and C1 cold/disabled fallback. Authenticated local selection/feedback/diagnostic/exposure endpoints preserve C1 prediction DTOs and immutable versions.

Logs retain candidate IDs/full-input hash, chosen features/context, C1 prediction, selection scores, linear uncertainty, design information, seed/config/version, nominal randomized probabilities and feedback/reward. Feedback intents contribute only after C1 commits. Active training-only C1 decisions govern reward fitting; holdout, SKIP, Undo, supersession and full-fit deletion are distinct. Contexts are rebuilt consistently for each selected C1 version.

The current user's utility requirement deliberately supersedes the master spec's deletion-only reward: 75% useful-review rating (or labeled completion proxy), 25% frozen prediction correction; no deletion bonus. Correction and linear-design information are proxies, not realized information gain. Exact behavior and schema proposals: [C2-api.md](C2-api.md).

## Verified November 7, 2026

Commands ran in this worktree using `UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache`, a writable copy of the locked local cache. Initial online dependency install failed due restricted DNS; offline install succeeded with no new dependencies.

- `uv run --offline pytest -q`: **308 passed** on the final package version: 214 C1 + 38 numerical/selector + 35 policy service + 21 simulator/benchmark tests. Finalization rerun: 17.11 seconds, zero failures.
- `uv run --offline python scripts/smoke_policy.py`: PASS real Uvicorn localhost auth, cold fallback, adaptation after KEEP, rating, retries, Undo, restart, immutable C1 explanation and policy logs.
- `uv run --offline python scripts/smoke_ml.py`: PASS unchanged real HTTP C1 smoke; 131 training examples and available synthetic holdout metrics.
- `uv lock --check --offline`, `uv build --offline`: pass, wheel and sdist; dependency versions unchanged.
- Installed `sortfm_ml-0.3.0` wheel in a clean Python 3.11 virtual environment under `/tmp` and ran the C2 simulation CLI from outside the repository: **pass**. Earlier no-project invocations selected unsupported system Python 3.9, then hit a host-installed pandas/NumPy ABI conflict in uv's overlay; a true isolated virtual environment resolved the host conflict. No dependency or source workaround was needed.
- Finalization reran the installed-wheel CLI with Python isolated mode (`-I`) from `/tmp` and verified exact JSON equality with the previous seeded run: **pass**. Confirmed Python 3.11.12, installed package 0.3.0, and import from the clean virtual environment's `site-packages`, not the checkout.
- Root `bun run typecheck`: pass. `bun run test`: **68 passed, 1 skipped**, zero failures. The A1 PostgreSQL integration test lacks its separate database configuration. An initial sandboxed run could not bind localhost; the socket-enabled run passed.
- Root `bun run build`: pass, retaining two pre-existing nonfatal Zod comment-annotation warnings. `git diff --check`: pass.
- Independent review covered numerical math, lifecycle, API, simulator and benchmark. Confirmed findings fixed with failing-then-passing regressions: redo/stale Undo releasing reservations; equivalent null/omitted features dropping active rewards; rejected events poisoning retries. Added C1 nonpolicy observation isolation from C2 corruption. Removed unnecessary full-queue O(N²D) ranking from the learned-policy path. No known material review finding is deferred.

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

There is no reservation expiry/release endpoint. Coordinate resurfacing SKIPs/abandoned reservations and session semantics before using C2 for production prefetch. Backend supplies current eligible membership and immutable event/exposure IDs. C1 deterministic scoring/ranking remains available without C2 reservations. The separately coordinated period-in-user-ID amendment remains with foundation/C1; C2 did not edit that shared/mirrored pattern.

Keep C2 experimental pending prospective validation. Actual Spotify/SoundNet data, human ratings, production deployment, long-term fatigue, distributed persistence, catastrophic kill recovery and retention/compaction are unverified. Synthetic counterfactual outcomes do not establish unbiased off-policy improvement. Adaptive supervised representations and selection constraints do not justify a formal LinUCB regret bound.

Final disposition: C2 is finalized locally per the user's explicit instruction. Keep `c2-contextual-bandit` unmerged in `sort.fm-c2`; the integration lead will integrate the local branch directly. No GitHub push is necessary or authorized, and no merge was performed by C2. The earlier rejected publication attempt is resolved by this local handoff, not an outstanding blocker or approval request.
