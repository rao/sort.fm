# C2 evaluation method and reproducibility

C2 evaluates **which library item to review next**, while C1 evaluates an item's removal preference. These are different objectives. The simulator uses the actual C1 `PreferenceModel`, the pure C2 `LinearUCB` and `select_candidate`, and no provider APIs or private listener data.

## Commands

Run from `services/ml` in the locked environment:

```sh
UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache uv run --offline pytest -q tests/test_simulate.py
UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache uv run --offline python -m sortfm_ml.simulate --seeds 11 29 47 --size 400 --budget 80 --holdout-size 150 --output experiments/c2-simulation-seeds11-29-47.json
UV_CACHE_DIR=/tmp/sortfm-c2-uv-cache uv run --offline python scripts/benchmark_bandit.py --size 2700 --training 100 --repeats 5 --output experiments/c2-benchmark-cpu.json
```

`--alpha`, `--epsilon` and `--ridge` configure the simulator's declared policy parameters. Defaults are alpha 0.5, epsilon 0.15, ridge 1; they were fixed before the recorded runs. Seeds must be distinct, and the exposure budget cannot exceed the library pool. The JSON contains every selected track, frozen C1 prediction, current context/version digest, candidate-set digest, selection score, ridge uncertainty, design information, conditional propensity when available, realized feedback/reward, learning checkpoints and aggregate summaries. A sibling Markdown report is generated from actual values. Simulation reports deliberately omit wall-clock timestamps and timings for exact replay in the recorded runtime; the separate benchmark records measured time.

## Declared synthetic environment

Environment version `synthetic-review-environment-v1` is an authored toy listener, not a human dataset. Each world seed spawns independent library and holdout random streams. Its library contains all candidate potential labels, usefulness values and skips *before* selection. Policies see only candidate metadata until they select an item. They never receive hidden outcomes for unselected tracks. The fixed holdout cannot be selected and contributes no features, centroids, labels or reward to training. Its labels are all available only to the evaluator, including tracks that hypothetically would have been skipped in a live interaction.

For each track, age `a = min(Exponential(mean=700), 5000)`, recent plays `r ~ Poisson(1.7)`, audio values energy `e`, acousticness `c` and danceability `d ~ Uniform(0,1)`, and short-term top-track membership `t ~ Bernoulli(0.2)`. Define:

```text
z = -0.15 + 0.6(a/1200) - 0.4r - 0.6t
    + 1.8(0.5-e) + 0.9(c-0.5) + 0.7(0.5-d) + Normal(0, 0.45)
p = 0.05 + 0.9 sigmoid(z)
label ~ Bernoulli(p)
ambiguity = 4p(1-p)
usefulness = clip(0.15 + 0.35 ambiguity + 0.25 min(a/1200,1)
                  + 0.15/(1+r) + Normal(0,0.07), 0, 1)
skip ~ Bernoulli(0.05 + 0.18 ambiguity)
```

The unobserved `p` is used by the synthetic generator and reported only as an environment diagnostic; it is never a policy input. The realized label and usefulness are separately sampled. Usefulness values reflect resolving neglected or ambiguous items and do not award points for deletion. Confirming KEEP can be just as useful as confirming REMOVE. This is one artificial operational definition; usefulness and fatigue require prospective listener validation.

Additional distractor metadata/audio fields are generated in valid contract ranges. Each provided feature independently has a 15% chance of being missing, and 8% of tracks lose all provided audio fields. Ten percent have unknown artists; the remainder use 40 synthetic artists. Missingness occurs after generating latent outcomes, preserving uncertainty from unobserved features. A score attached to an unknown artist is never counted as evidence of artist diversity.

## Sequential experiment and reward

Every policy starts with zero training labels, receives the same library and independent test set for a world, and consumes exactly the requested number of exposures without repeating tracks. SKIP consumes one exposure, gives no training label and has `reward=null`; it contributes zero to cumulative reward. Every completed library review enters training in this controlled experiment. This differs from serving, where C1's stable feedback split can reserve selected feedback for holdout. The synthetic test pool is already entirely disjoint, so no service split is needed here.

After each completed selected review, the simulator constructs a fresh C1 fit using only that policy's selected completed labels. Before the next selection it rebuilds all observed bandit contexts using the current C1 model, including its current medians, scales, centroids and probability. The rewards associated with those observations remain frozen at their exposure-time predictions. The simulation does not reuse old sufficient statistics across representation changes.

Reward version `review-utility-v1` is:

```text
completed reward = 0.75 usefulness + 0.25 (label - frozenRemovalProbability)^2
heuristic correction = 0
```

The label remains C1's target (KEEP 0, REMOVE 1). The reward measures review utility plus a bounded correction/surprise proxy. The second term is **not realized information gain**; it can increase when C1 is wrong. Therefore total reward must be read alongside usefulness and holdout prediction quality. No deletion bonus is present. For synthetic reporting only, a completed review is counted as useful when its usefulness is at least 0.6; the denominator of the primary useful-review rate is all exposures, including skips. The raw usefulness sum and completed-only rate are also preserved.

The core's `0.5 log(1 + x^T A^-1 x)` is reported as a design-information proxy, separately from reward. C1 entropy is predictive ambiguity, ridge leverage uncertainty describes the reward regression's design coverage, and neither is a probability of a correct decision. Rebuilding contexts prevents inconsistent coordinates, but the changing representation does not satisfy a stationary contextual-bandit regret theorem.

## Baselines and interpretation

| Policy | Selection | Constraints |
|---|---|---|
| `c1` | First item of `PreferenceModel.rank(limit=1)`, recomputed after each exposure | C1 exact fallback; no C2 artist or exploration constraints |
| `random` | Uniform over every remaining track | No artist/obvious-keep constraints; unrestricted random selection |
| `epsilon_greedy` | Learned reward mean; epsilon 0.15 random exploration | C2 25% prefix exploration cap, three-exposure artist window, max one artist occurrence, obvious-keep threshold 0.1 |
| `linucb` | Learned reward mean plus alpha 0.5 times ridge leverage uncertainty | Same C2 constraints as epsilon-greedy |

Both adaptive policies use the C1 cold fallback before any reward observation, retaining their artist constraints. They then learn from actual review rewards even while C1 still lacks enough class-balanced labels for logistic fitting. Random is random from its first choice. “Explore” means the selected track differs from the reward-greedy candidate; a random draw that happens to choose that candidate counts as exploit. These comparisons evaluate explicitly specified deployable configurations; they do not isolate a causal effect of exploration from the diversity/protection rules. The first-item C1 baseline does not invoke the multi-position diversity bonus or recent-save quota of a precomputed multi-item C1 queue.

Potential **labels/usefulness/skips** are common across policies, but the correction component depends on each policy's learned classifier and frozen exposure prediction. Consequently policy rewards are adaptive and the same track need not receive the same total reward under different classifiers. Every run records this distinction rather than treating total reward as a stationary song property.

## Prediction metrics and statistical limits

The fixed holdout is evaluated at zero exposures, every 20 exposures, and the final budget. Existing C1 eligibility applies: at least 20 holdout labels, both test classes, and an eligible trained classifier. Otherwise metrics are null with reasons. The final report separately includes holdout Brier score, log loss, ROC AUC and training-label counts; complete C1 metrics and learning checkpoints remain in JSON. Repeated checkpoint inspection is descriptive and never tunes parameters or selects a model.

Per-policy aggregates show arithmetic means and sample standard deviations across distinct world seeds. A single-seed run reports null standard deviation. Null predictive metrics are excluded from that metric's aggregate and its available count remains explicit. Paired cumulative-reward differences match world seeds; they are descriptive seed variation, not confidence intervals or statistical proof of improvement. Three worlds are a small illustration, not a power analysis.

No historical production feedback is replayed as though it were selected by another policy. There is no IPS or doubly robust estimator in this simulator and no unbiased off-policy uplift claim. Deterministic-policy propensities remain null under the contract. Common counterfactual outcomes exist only because the environment is synthetic. Global sequential regret is not reported: classifier-dependent correction rewards and changing representations do not define a stationary comparator, and no LinUCB regret bound is claimed.

## CPU benchmark scope

The benchmark generates 2,800 synthetic tracks, selects 100 completed historical reviews, and scores the remaining 2,700. It uses one unreported warm-up and five measured runs. Stages measure actual C1 refitting, full C1 prediction including explanations, C2 candidate-context construction, observed-context/policy rebuilding, and pure C2 selection. `fullSelectionSeconds` is the sum of prediction, context, rebuild and selection time; it excludes the C1 refit as well as HTTP, persistence, JSON serialization, load and process coordination. All repeated selections must match exactly before a report is accepted.

The numerical workload uses fixed reward fixtures with frozen probability 0.5. A separate service workload creates a fresh temporary artifact directory per repetition, fits 100 C1 labels, records one actual policy exposure and completed usefulness feedback, then measures an authenticated in-process ASGI request selecting among the same 2,700 remaining candidates. That request includes request/response JSON, validation, authentication, artifact checksums, locking and durable writes. Its `trainedRewards=1` differs from the numerical workload's 100 reward fixtures and is recorded explicitly. The service workload also has one excluded warm-up and five measured repetitions, with exact replay checked.

These are computational workloads, not effectiveness experiments. CPU results are local wall-clock samples with ordinary machine contention, not service latency guarantees. The ASGI measurement excludes the network socket, TLS and deployed concurrency. Neither workload measures memory growth or a deployed end-to-end SLA. Consult the recorded JSON for the exact numerical-runtime versions, input digest, individual timings and medians.

## Verification boundaries

Tests exercise actual policy/C1 code, including exact deterministic report replay, CLI output, invalid experiment designs, equal budgets and no repeats, skip exclusion, exposure-frozen reward arithmetic, holdout noninterference, unselected-counterfactual noninterference, common outcomes across policies, aggregate arithmetic, and real benchmark execution. Numerical LinUCB and production lifecycle behavior are tested separately by their owning modules.

Actual Spotify/SoundNet data, human usefulness reports, prospective randomized effectiveness, long-term fatigue, production deployment performance and calibrated probabilities remain unverified. The simulator does not test service persistence, Undo or HTTP authentication; those require the C2/C1 service suites.
