# Reproducible C1 evaluation

The checked-in [JSON report](../experiments/c1-demo-seed42.json) and [readable report](../experiments/c1-demo-seed42.md) contain actual measurements from the commands below. No real listener labels were available. Synthetic measurements and the AI-authored adaptation fixture are engineering checks, not evidence of useful removal recommendations for people.

Run from `services/ml`:

```sh
uv sync --locked
uv run python -m sortfm_ml.cli demo --seed 42 --size 600 --output experiments/c1-demo-seed42.json
uv run python -m sortfm_ml.cli evaluate path/to/fit-request.json --output experiments/evaluation.json
uv run python -m sortfm_ml.cli train path/to/fit-request.json --artifacts artifacts/models --output experiments/fit-response.json
```

`demo` and `evaluate` write a JSON report and a sibling Markdown report. `train` validates the same strict FitRequest, publishes a version through ModelService, and writes only the FitResponse JSON. Training artifacts use the service's atomic persistence and can be loaded by a fresh ModelService or HTTP process with the same artifact directory. Use a new experiment/user identity when intentionally changing the split or evaluation seed; an existing service ledger preserves its split.

To make a reproducible FitRequest for the last two commands without external data:

```sh
uv run python -c 'import json; from pathlib import Path; from sortfm_ml.cli import generate_synthetic; Path("experiments/synthetic-fit.json").write_text(json.dumps(generate_synthetic(seed=42, size=600), indent=2))'
uv run python -m sortfm_ml.cli train experiments/synthetic-fit.json --artifacts artifacts/models --output experiments/fit-response.json
uv run python -m sortfm_ml.cli evaluate experiments/synthetic-fit.json --output experiments/evaluation.json
```

## What is measured

The target is explicit REMOVE (`1`, ARCHIVE or UNLIKE) versus KEEP (`0`). Historical likes, SKIP, and weak listening signals are never labels. A FitRequest names one user; the caller is responsible for sending only that user's labels. Both service training and the experiment CLI reject unpermitted training examples and mixtures of synthetic and non-synthetic provenance. The lower-level model filters unpermitted training rows defensively. Evaluation reports the supplied label count, the model's actual eligible training count, and both holdout class counts separately.

All ablations use the same fixed holdout and fixed model hyperparameters. The cumulative groups are metadata; metadata plus history; those plus audio; and those plus training-label-derived similarity. The regularized logistic model uses its source-declared settings; the runner never selects a winner, tunes the decision threshold, calibrates probabilities, or changes preprocessing using holdout results. Medians, scaling, and kept/removed centroids are fitted on training examples only. Training similarity is leave-one-out; held-out similarity uses the training centroids.

For generated data, SHA-256 of the JSON tuple `[seed,userId,trackId]`, modulo five, assigns bucket zero to holdout. It does not inspect features or labels. For caller-provided FitRequests, `evaluate` preserves each supplied `split` exactly. Every report records the exact holdout IDs, their SHA-256 digest, the input digest, the seed, and Python/NumPy/scikit-learn versions. Repeated runs with the same input and runtime reproduce scores and metrics; actual `evaluatedAt` timestamps change.

The learning curve uses nested seeded subsets of training rows while holding the same evaluation set fixed. Its points are measured fits, not interpolated curves, and need not improve monotonically. Counts in each point describe the supplied subset plus the unchanged holdout. Cold or one-class training subsets remain heuristic models with null evaluation metrics.

The three controls are a constant probability equal to the training removal rate, seeded random ranking, and ranking by saved age. Age missingness is filled with the training median. The last two produce ranking scores, so balanced accuracy, log loss, and Brier score stay null. They do not claim removal probabilities. Their `trainedExamples` is zero; the age control separately reports the number of rows used to calculate its imputation median. Ties in precision@k use ascending track ID, which is also used for constant-prior ties.

Metric conventions:

- A full available result requires a supervised fit, at least 20 holdout labels, and both holdout classes. Otherwise every metric, including base rate, is null, with actual counts and a reason. Invalid or incomplete model probabilities yield `unavailable` rather than a partial metric set.
- Balanced accuracy is the mean sensitivity and specificity at the fixed `0.5` threshold. ROC-AUC uses probability rankings and handles tied scores.
- The frozen wire field `prAuc` means **non-interpolated average precision**, calculated by `sklearn.metrics.average_precision_score`; it is not trapezoidal PR integration.
- Log loss is binary cross-entropy with scikit-learn's numerical clipping. Brier score is mean squared probability error. Lower is better for both.
- Precision@k uses the ten highest removal probabilities/ranking scores, with `k=min(10, holdout size)`. It is particularly noisy on this small holdout.
- JSON reports contain five predeclared probability bins `[0,.2)`, `[.2,.4)`, `[.4,.6)`, `[.6,.8)`, and `[.8,1]`. Each includes count, mean predicted probability, and observed removal fraction. Empty-bin means are null. These are descriptive reliability diagnostics, not a fitted calibration procedure or a calibration claim. No confidence intervals are claimed.

## Data provenance

`generate_synthetic` creates fictional metadata and audio-like numbers with missingness. A fixed latent rule combines saved age, observed-play proxies, energy, danceability, and acousticness, adds Gaussian noise, and samples a Bernoulli label. Probabilities retain a noise floor. Those simulated audio values are not SoundNet observations. This declared generator intentionally contains signal in the feature groups and cannot assess their importance for real listeners. The implementation and seed fully specify the dataset; no result was used to tune the generator or model.

[authored_profiles.json](../fixtures/authored_profiles.json) has 24 explicitly curated, made-up feature profiles with **AI-authored illustrative labels; not human/listener feedback**. It tests whether added labels change a fixed probe's score. Its last twelve illustrative REMOVE labels deliberately shift the target profile's preference. All profiles have synthetic provenance and all belong to training; it has no holdout and therefore has no available validation metrics. It does not satisfy a requirement for independently human-labeled data, which remains an explicit acceptance gap.

The frozen dataset enum is coarse. Any synthetic feature provenance makes a lower-level evaluation `synthetic`; all-licensed provenance maps to `licensed`; Spotify/SoundNet feedback maps to `user_feedback`. That mapping does not independently authenticate a label's human origin. The CLI records this distinction in `labelProvenance` and does not assert that arbitrary caller-supplied labels were collected from a listener.

## Recorded seed 42 result

The 600-example run used 465 training labels and 135 fixed holdout labels: 69 REMOVE and 66 KEEP, a removal base rate of 0.5111.

| Model/control | ROC-AUC | PR-AUC (average precision) | Log loss | Brier |
|---|---:|---:|---:|---:|
| Metadata | 0.5231 | 0.5324 | 0.6996 | 0.2530 |
| + History | 0.5747 | 0.5632 | 0.6891 | 0.2479 |
| + Audio | 0.5964 | 0.6145 | 0.6983 | 0.2510 |
| + Personalized similarity | 0.5990 | 0.6083 | 0.6976 | 0.2506 |
| Constant training prior | 0.5000 | 0.5111 | 0.6938 | 0.2503 |
| Seeded random ranking | 0.4556 | 0.5213 | — | — |
| Saved-age ranking | 0.6752 | 0.6880 | — | — |

The personalized model **does not beat the age-ranking control in ROC-AUC**, and its probability loss is slightly worse than the constant-prior control. Adding feature groups does not consistently improve all metrics. The personalized learning curve is non-monotonic; the full report retains every measured point. These negative results are preserved and do not justify model superiority, calibration, a production accuracy claim, or a stronger-model deployment.

On the authored mechanism fixture, the fixed probe's uncalibrated removal probability changes from 0.213648 to 0.702318 after 12 → 24 training labels. This shows deterministic adaptation to the supplied illustrative labels only. Real current listener decisions, prospective validation, realistic temporal drift, selection/exposure bias analysis, and enough held-out labels remain missing.

## Verification

`uv run pytest tests/test_evaluate.py -q` checks metric arithmetic against independently calculated values, output identity joins, insufficient/one-class holdouts, invalid scores, duplicate tracks, provenance/count reporting, fixed split generation, common holdouts and disjoint training subsets, reliability-bin counts, negative/large evaluation seeds, permission/mixed-source rejection, fixture adaptation, all three CLI modes, and persisted reload equivalence. The full Python suite also covers model leakage, missing features, service restart/undo/replay, and HTTP contracts.
