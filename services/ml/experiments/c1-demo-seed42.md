# Fixed-holdout experiment

Exploratory offline measurements. No real listener validation is included in this repository. No calibration or real-world usefulness is established.

Label source: Synthetic noisy Bernoulli labels from the declared generator

Seed: 42. Holdout: 135 tracks.
Held-out REMOVE labels: 69; KEEP labels: 66. Removal base rate: 0.5111111111111111.
Holdout identity SHA-256: `1c220053c565aa370b5cbf4d14d1e1a1f8b194c01d1f77aaa933fe917bbc49b3`.

PR-AUC uses non-interpolated average precision. Precision@k uses k=10 (or the whole holdout if smaller). Classification threshold is 0.5. No holdout tuning or calibration.

| Model | Trained | Balanced accuracy | ROC AUC | PR AUC (AP) | Log loss | Brier | Precision@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
| metadata | 465 | 0.5270 | 0.5231 | 0.5324 | 0.6996 | 0.2530 | 0.5000 |
| history | 465 | 0.5481 | 0.5747 | 0.5632 | 0.6891 | 0.2479 | 0.4000 |
| audio | 465 | 0.5991 | 0.5964 | 0.6145 | 0.6983 | 0.2510 | 0.7000 |
| personalized | 465 | 0.5771 | 0.5990 | 0.6083 | 0.6976 | 0.2506 | 0.8000 |
| constant_training_prior | 465 | 0.5000 | 0.5000 | 0.5111 | 0.6938 | 0.2503 | 0.4000 |
| seeded_random_ranking | 0 | — | 0.4556 | 0.5213 | — | — | 0.6000 |
| saved_age_ranking | 0 | — | 0.6752 | 0.6880 | — | — | 0.9000 |

## Learning curve

Same holdout at every point; training subsets are nested and seeded.

| Training labels | Model | ROC AUC | Log loss | Brier |
|---:|---|---:|---:|---:|
| 0 | heuristic | — | — | — |
| 6 | heuristic | — | — | — |
| 12 | logistic | 0.5268 | 0.7714 | 0.2804 |
| 24 | logistic | 0.4895 | 0.8664 | 0.3133 |
| 48 | logistic | 0.5114 | 0.8226 | 0.2988 |
| 96 | logistic | 0.5448 | 0.7913 | 0.2853 |
| 192 | logistic | 0.5531 | 0.7691 | 0.2810 |
| 465 | logistic | 0.5990 | 0.6976 | 0.2506 |

## Authored fixture adaptation

These made-up feature profiles and manually assigned illustrative labels test deterministic adaptation only. They are not observations of any listener and provide no evidence of real-world utility.

The fixed probe's removal score changed from 0.213648 to 0.702318 after 12 → 24 training labels. This is a deterministic mechanism check with no holdout; all validation metrics remain null.

## Limits

Synthetic labels come from a declared noisy generator that contains metadata/history/audio signal. These figures measure recovery of that artificial rule. They do not establish generalization to listeners, model calibration, or reliable archive suggestions. The authored fixture was created by an AI agent and is not human-labeled data. Actual user feedback, temporal/exposure bias analysis, and prospective validation remain missing.
