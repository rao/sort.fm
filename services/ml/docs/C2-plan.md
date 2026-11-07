# C2 contextual bandit implementation plan

**Goal:** Implement the assigned C2 brief on approved foundation `9dab2fa`, retaining C1 behavior and all frozen shared contracts.

**Architecture:** Shared linear LinUCB estimates review utility separately from C1 removal preference. The policy uses C1's pinned transform and rebuilds sufficient statistics from eligible active decisions after each model change or Undo. Immutable selection logs retain the original contexts and predictions. Service-local authenticated endpoints propose integration additions without editing other owners' modules.

**Stack:** Existing Python, NumPy, FastAPI, Pydantic and POSIX artifact persistence; no new dependencies.

**Scope:** `services/ml/**` only. C2 brief and current user instructions are the acceptance criteria; the user's cleanup-utility requirement supersedes the master spec's deletion-only reward.

## Decisions

- Action is one song exposure. Context includes bounded C1 features, an intercept and the C1 probability/explicit heuristic score. A shared linear model generalizes across new songs; individual song IDs are not learned arms.
- `A = ridge I + X^T X`, `b = X^T r`, `theta = solve(A,b)`, score `x^T theta + alpha sqrt(x^T A^-1 x)`. Alpha/ridge are configurable; alpha zero disables optimism. Deterministic LinUCB propensities are null under the frozen convention; epsilon-greedy/random report exact conditional probabilities only.
- Reward v1 is `0.75 * usefulness + 0.25 * (label - frozenRemovalProbability)^2`. Optional explicit usefulness in [0,1] overrides the default completed-review proxy of 1. Cold heuristics have no probability, so the correction term is zero. Both confirmed keeps and removals can be useful. Squared error is a surprise/correction proxy, not realized information gain. Design information `0.5 log(1 + x^T A^-1 x)` is logged separately and is not added again to rewards.
- SKIP gives no reward or label. C1's active training-only ledger decides whether an exposure reward contributes; holdout feedback never trains the policy. Undo or full-fit removal eliminates the active contribution. Frozen contexts remain historical evidence, while active contexts are consistently rebuilt under the selected current/pinned model.
- New `/policy/select`, `/policy/feedback`, `/policy/diagnostics`, `/policy/exposure` endpoints are explicitly local proposals. Existing `/fit`, `/score`, `/observe`, `/evaluation`, `/explain` request and response schemas remain unchanged.
- No-repeat history, capped exploration, artist-window constraints with explicit infeasibility relaxation; missing artist metadata must be visible. Disabling policy returns C1's deterministic ranked queue.
- The simulator generates its own counterfactual environment, separates utility/cumulative reward/regret diagnostics from fixed-holdout classifier metrics, and compares random, C1, epsilon-greedy and LinUCB. No unbiased off-policy uplift claim from historical selected feedback.

## Implementation and verification

- [x] Numerical core and selector: hand-derived ridge solutions, repeated updates, information geometry, seed replay, caps/diversity and missing-data fallbacks.
- [x] Service adapter and typed local endpoints: auth, idempotency, exposure integrity, current/pinned model contexts, fit/observe/Undo synchronization, isolated users, restart and storage failures.
- [x] Simulator and benchmark: independent worlds/seeds, actual C1 adaptation, equal budgets, fixed untouched holdout, rewards and selections replay exactly; synthetic provenance and limits recorded.
- [x] Full Python tests, C1 and C2 real HTTP smokes, package build, root tests/typecheck/build, numerical/runtime benchmarks, independent review; material findings fixed.
- [x] Measured results and integration handoff, focused commits, no merge.

## Review focus

1. Reusing old A matrices after C1 feature scales/centroids change must never mix coordinate systems.
2. Retried selections, delayed feedback, Undo and superseded decisions must not create duplicate policy updates.
3. Partial filesystem failures must recover the original decision and never resample a retry.
4. A saved/queued item is an exposure reservation, not proof of viewing or usefulness.
5. Missing audio/artists, permission flags, holdout contamination and deterministic policies must remain honestly described.

## Execution record

Worktree created at `../sort.fm-c2`, branch `c2-contextual-bandit`. Native worktree tool could not target the repository because the chat directory is its parent; used the Git worktree fallback. Initial uv install hit restricted DNS; reusing the already locked local cache/environment for verification.

Final verification: 308 Python tests; 68 root tests plus one environment-dependent PostgreSQL skip; root typecheck/build; C1+C2 real loopback HTTP smokes; Python package build. Four independent-review lifecycle findings were reproduced then fixed, including stale/no-op Undo. Cold artist-diversity regression also fixed. All scoped changes remain unmerged. See C2-handoff.md for exact measurements and operational/integration limitations.
