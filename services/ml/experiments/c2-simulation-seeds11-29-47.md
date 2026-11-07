# C2 reproducible synthetic policy evaluation

Synthetic on-policy simulation with generated counterfactual outcomes; not historical off-policy evaluation, real listener validation, calibration, or proof of policy improvement.

Seeds: [11, 29, 47]. Per seed: 400 candidate tracks, 80 exposures per policy, 150 disjoint held-out tracks. All policies start with zero labels.

Values are mean ± sample standard deviation across seeds. Standard deviations describe seed variation; they are not confidence intervals. Reward weights and all hyperparameters were fixed before these runs.

| Policy | Cumulative reward | Useful reviews / exposure | Completed / training labels | Removals (secondary) | Exploration choices | Distinct known artists |
|---|---:|---:|---:|---:|---:|---:|
| c1 | 38.9434 ± 2.5789 | 0.6458 ± 0.0813 | 67.3333 ± 3.0551 | 33.3333 ± 7.5056 | 0.0000 ± 0.0000 | 34.0000 ± 1.0000 |
| random | 34.6006 ± 1.3846 | 0.4750 ± 0.0696 | 67.0000 ± 1.7321 | 25.6667 ± 1.1547 | 79.6667 ± 0.5774 | 34.3333 ± 1.1547 |
| epsilon_greedy | 37.8950 ± 2.2314 | 0.6000 ± 0.0331 | 67.3333 ± 3.0551 | 29.6667 ± 9.4516 | 11.3333 ± 2.0817 | 31.3333 ± 1.5275 |
| linucb | 35.4528 ± 0.8997 | 0.5625 ± 0.0375 | 64.3333 ± 2.8868 | 26.6667 ± 0.5774 | 19.3333 ± 0.5774 | 31.3333 ± 4.7258 |

## Separate supervised predictive evaluation

The same fixed test set is never selectable or used to fit features, centroids, the classifier, or the bandit. Unavailable metrics remain null when C1 eligibility fails. All probabilities remain uncalibrated.

| Policy supplying training labels | Holdout Brier ↓ | Holdout log loss ↓ | Holdout ROC AUC ↑ |
|---|---:|---:|---:|
| c1 | 0.2532 ± 0.0224 | 0.8228 ± 0.1142 | 0.6166 ± 0.0422 |
| random | 0.2439 ± 0.0132 | 0.6978 ± 0.0369 | 0.5913 ± 0.0181 |
| epsilon_greedy | 0.2889 ± 0.0775 | 0.9485 ± 0.4191 | 0.5421 ± 0.0444 |
| linucb | 0.2650 ± 0.0114 | 1.0076 ± 0.2613 | 0.5914 ± 0.0669 |

## Paired reward differences

Same environment seed in each pair; adaptive model states and subsequent selected feedback differ.

- linucb minus c1: -3.4906 ± 2.6744
- linucb minus random: 0.8522 ± 0.5565
- linucb minus epsilon_greedy: -2.4421 ± 1.8219

## Interpretation and limits

Usefulness is a declared synthetic outcome about resolving neglected or ambiguous library items. Both KEEP and REMOVE can be useful. A completed review is counted as useful at usefulness ≥ 0.6; skips cost budget but supply no label or reward. The correction signal rewards a revealed mismatch with the frozen C1 probability; it is not measured information gain. Increasing it can reflect worse predictions, so assess usefulness and held-out prediction metrics alongside total reward.

The random baseline is unrestricted. C1 uses the first item of its recomputed deterministic rank. Adaptive policies use the documented exploration and artist constraints; this compares deployable configurations, not an isolated causal effect of optimism. A missing artist does not establish diversity.

All counterfactuals are synthetic and generated before selection. No unseen real feedback is imputed, and no unbiased off-policy policy-improvement claim is made. Global sequential regret is not estimated; adaptive C1 representations and prediction-dependent reward invalidate a stationary-reward interpretation. Design information gain is only a ridge-geometry proxy.

No parameters were selected from these holdout results. Real listeners, live service latency, long-term retention and prospective randomized policy effectiveness remain untested. See docs/C2-evaluation.md for the environment, commands and benchmark scope.
