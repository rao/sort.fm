# sort.fm preference engine and contextual bandit (C1 + C2)

For **50–80 real Keep/Remove judgments without Spotify mutations**, use the
[calibration workflow and inspector handoff](docs/C1-calibration-handoff.md).
It prepares a stratified sample, freezes train-only models before final labels,
and evaluates saved holdout predictions against age/metadata controls. Real
metrics remain unavailable until actual listener labels are supplied.

Python 3.11+, FastAPI, NumPy and scikit-learn. C1 estimates a listener's **removal preference**. C2 separately selects useful review candidates with constrained shared-linear LinUCB. The user makes every removal decision; the service has no Spotify client, credentials, mutation code or frontend.

C2 package `0.3.1` preserves all existing C1 contracts and immutable model formats. The approved service-local lifecycle adds bounded leases, idempotent release and reservation/eligibility inspection; **production C2 activation remains disabled**. Read the [C2 handoff](docs/C2-handoff.md), [local policy API and integration gates](docs/C2-api.md), [implemented lifecycle design](docs/C2-reservation-proposal.md), [evaluation method](docs/C2-evaluation.md), and [actual synthetic results](experiments/c2-simulation-seeds11-29-47.md). LinUCB did not beat C1 or epsilon-greedy in the recorded simulator; no real-listener or unbiased off-policy improvement is claimed. Shared-contract/public UI/Tiger Data adoption remains with integration.

From this directory, run `uv run python scripts/smoke_policy.py` for the real C2 HTTP smoke; `uv run python -m sortfm_ml.simulate --seeds 11 29 47 --size 400 --budget 80 --holdout-size 150 --output experiments/c2-simulation-seeds11-29-47.json` reproduces the simulation. `uv run python scripts/benchmark_bandit.py --output experiments/c2-benchmark-cpu.json` measures the declared local CPU and authenticated ASGI workloads. Existing C1 commands below remain valid.

## Install, train, evaluate, serve

Run from `services/ml`:

```sh
uv sync --locked
uv run pytest -q
uv run python -m sortfm_ml.cli demo --seed 42 --size 600 --output artifacts/demo-report.json
uv run python -m sortfm_ml.cli evaluate /absolute/path/feedback.json --output artifacts/feedback-evaluation.json
uv run python -m sortfm_ml.cli train /absolute/path/feedback.json --artifacts artifacts/models --output artifacts/fit-response.json
```

`feedback.json` is a canonical `FitRequest` (see `../../packages/contracts/src/features.ts`):

```json
{
  "userId": "demo:listener",
  "featureVersion": "sortfm.features.v1",
  "feedbackRevision": 1,
  "evaluationSeed": 42,
  "examples": [
    {
      "trackId": "demo:track-001",
      "decisionId": "f95764ae-f139-4c8d-81fd-93f97f7ea104",
      "label": 0,
      "split": "train",
      "labeledAt": "2026-11-07T12:00:00Z",
      "features": {
        "featureVersion": "sortfm.features.v1",
        "values": {"energy": 0.6, "saved_age_days": 12},
        "provenance": "synthetic",
        "permittedForTraining": true,
        "rightsBasis": "Original fictional example"
      }
    }
  ]
}
```

The one-row example intentionally stays in heuristic mode. Replace it with actual completed feedback and truthful provenance. Never label imported Likes automatically. A full fit is the complete current active-label snapshot, including fixed holdout assignments; omitted active rows are revoked. Use increasing revisions. Do not upload feedback or artifacts to Git.

Set `ML_SERVICE_SHARED_SECRET` through the process environment/secret manager and use the same artifact directory for training and serving:

```sh
export ML_ARTIFACT_DIR=artifacts/models
uv run uvicorn sortfm_ml.app:app --host 127.0.0.1 --port 8000
```

For Railway/private hosting bind `0.0.0.0` and the configured port, mount persistent storage, and set `ML_ARTIFACT_DIR` to that mount. Use one replica with a local POSIX filesystem. Multiple Uvicorn workers on that same filesystem are coordinated by per-user file locks. Separate replicas or remote object stores require an integration-owned persistence adapter. Liveness is not a storage-readiness probe.

`uv run python scripts/smoke_ml.py` launches an isolated loopback server, exercises real HTTP auth/fit/score/observe/explain, restarts it and checks exact replay. It uses only temporary synthetic data and deletes its state. From the repository root, `bun run smoke:ml` additionally validates actual Python responses with the shared TypeScript Zod contracts, including cold start, computed metrics, Undo, immutable exposure retry, conflicts and user isolation.

## C2 lifecycle and activation gates

New selections use scheduler `c2-linucb-v3`. Every strategy, including the local C1 baseline, shares lease/completed-review filtering. Integrated requests pin both the current successful C1 fit version and its feedback revision. `ML_POLICY_RESERVATION_TTL_SECONDS` sets a startup TTL of 30–900 seconds, default 300. Deadlines and historical retries never renew. Authenticated `/policy/release` closes one exposure; `/policy/exposure` reports its frozen decision and current lease. Release/expiry never cancels provider work or revokes labels. Policy design uncertainty remains separate from C1 predictive uncertainty.

Storage format 3 adds immutable committed cleanup associations and migrates verified v1/v2 state without rewriting original decisions, predictions or deadlines. V1 deadlines remain original creation plus 300 seconds. Back up the complete artifact directory before upgrading; rollback requires restoring the backup. No automatic backup or retrospective association backfill is performed.

The approved [association protocol](docs/C2-association-api.md) leaves C1's `/fit` worker independent. A separate durable worker sends committed cleanup events to `/policy/associate` with a refreshable current fit receipt. ML validates the original exposure and counts only the latest matching permitted training decision. Coalesced events remain inactive history; SKIP/Undo close only their original exposure. Calibration never creates policy rewards. Do not add `/observe` beside `/fit`. Database eligibility, guarded publication, telemetry and the disabled-by-default feature flag remain integration-owned gates; C2 is not publicly activated by this package.

`uv run python scripts/smoke_policy_association.py` verifies the snapshot protocol over real localhost HTTP with synthetic temporary artifacts, including real expiry and restart.

See [C2 protocol handoff](docs/C2-protocol-handoff.md) for the verified 0.4.0 results and integration gates.

## Statistical behavior

- **Target:** KEEP = 0; confirmed ARCHIVE/UNLIKE = 1. SKIP sends a null-label upsert and adds no training example. UNDO sends a null-label revoke targeting the original decision. Repeated events are idempotent; stale revisions and conflicting IDs return errors. An Undo for an older superseded decision cannot erase the newer decision.
- **Cold start:** fewer than 12 training labels or fewer than 3 of either class uses a transparent heuristic. Its neutral score is 0.5, with small keep-affinity deductions for recent saves and observed recent plays. A save older than 90 days gets no age penalty. Historical tops do not set cold scores. `removalProbability=null`, `calibrated=false`, and uncertainty is absent. The thresholds are engineering defaults, not validated sample-size claims.
- **Supervised baseline:** per-user L2 logistic regression (`C=0.5`, LBFGS, fixed tolerance/seed), refit after every accepted feedback change. This fast batch update supports exact deletion of revoked examples and avoids incremental-SGD reversal errors. No class balancing or pseudo-labels distort the observed removal base rate.
- **Preprocessing:** fixed ordered columns, log transforms for skewed counts/ages/tempo, training-only medians and IQR scaling, bounded standardized values, and a missing indicator for every column in the C2 context. New C1 fits suppress missing indicators in the classifier and gate sparsely supported audio/centroid predictors; see the calibration handoff. Zero is observed. API input rejects NaN, infinity, invalid bounds and unsupported versions; numerical helpers also protect against malformed local observations. All-empty and constant columns are supported.
- **Audio:** accepts validated normalized SoundNet values under the shared contract. Percentages must already be in `[0,1]`, loudness numeric dB, tempo BPM, key cyclic, and missing values null/omitted. Raw provider parsing, caching and source verification belong to D. No audio API or network call is required for inference.
- **Personalization:** audio distances to kept/removed centroids are constructed internally from permitted training rows. The current training track is excluded from its own reference pools. Missing audio does not invent similarity evidence. Caller-provided centroid distances are ignored because their provenance cannot prove holdout isolation. Changing holdout labels/features cannot change fitted preprocessing or probabilities.
- **Explanations:** largest standardized coefficient contributions plus intercept and summed remainder reconstruct removal log odds. They describe associations, not causal reasons. Trained probabilities remain `calibrated=false`; normalized binary entropy measures predictive ambiguity, **not** epistemic confidence or a confidence interval.

The model's `predict()` preserves candidate order. `PreferenceModel.rank()` is an optional deterministic diversity-aware review helper, with at least one recent save in the first five when available and the requested limit permits. It does not modify probabilities and is not a bandit. Candidate DTOs contain no artist IDs, so artist-diversity constraints belong to the backend/C2 with library metadata.

## Evaluation and reproducibility

The dataset supplies fixed `train`/`holdout` identities. Neither labels nor feature statistics from holdout enter training. The service remembers a track's split even after revocation and rejects moves or evaluation-seed changes. New `/observe` tracks use SHA-256 of `[evaluationSeed,userId,trackId]`, modulo 5: bucket 0 is holdout. Thus even new feedback can be evaluation-only. The first fit may supply its explicit seed/split; later snapshots must preserve it. To start a truly new offline experiment, use an isolated artifact directory instead of moving holdouts in the serving user ledger.

Metrics require at least 20 heldout labels, both holdout classes, and an eligible supervised fit. Otherwise all metric values are null with a reason. Measures are balanced accuracy at threshold 0.5, ROC AUC, non-interpolated average precision (`prAuc`), log loss, Brier score and precision@10, with class counts and base rate. Do not interpret early or repeatedly inspected holdout results as independent confirmation.

The CLI compares metadata, +history, +audio and +personalized distances on exactly the same holdout. Controls include constant training prior, seeded random ranking and age ranking. Age ranking is an evaluation control, not a claim that old songs are disliked. Training-size curves use nested seeded subsets and an unchanged holdout. Hyperparameters/thresholds are fixed before evaluation; no holdout tuning or automatic winner selection occurs.

See [measured experiment report](experiments/c1-demo-seed42.md) and [experiment method/limits](docs/experiments.md). The default synthetic experiment **does not beat all controls**. No real listener labels were available. The authored toy fixture is explicitly AI-authored, not human-labeled evidence; actual user effectiveness and calibration remain unverified.

`uv.lock`, input/holdout hashes, seed, exact runtime versions, explicit feature ordering and stored model/preprocessor state reproduce the experiment. Evaluation timestamps and measured runtimes naturally differ between runs. Scoring the same input under a pinned stored model version is exact within the locked runtime. Artifacts reject a different numerical-library/engine format version. New fitting semantics use `MODEL_RECIPE` in model identity while backward-compatible readers preserve old models; change `ENGINE_VERSION` for an incompatible artifact/runtime format. Cross-runtime bitwise reproduction is not promised.

This follows scikit-learn's guidance on [training-only preprocessing](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage), [calibration interpretation](https://scikit-learn.org/stable/modules/calibration.html), and [trusted, version-compatible persistence](https://scikit-learn.org/stable/model_persistence.html).

## TypeScript/internal HTTP integration

Shared contracts remain `1.0.0` / `sortfm.features.v1`, including integration amendment `c35cd96` (optional scoring exposure IDs). `schemas.py` mirrors the exported JSON Schema and cross-field refinements; tests validate real outputs against the generated artifact. Never send public browser-controlled user identity directly here: the authenticated backend derives and authorizes `userId`. The internal shared key authenticates the trusted backend, not individual Spotify users.

| Method | Route | Behavior |
|---|---|---|
| GET | `/health` | Public liveness; scoring/training capabilities true |
| POST | `/fit` | Full active-label snapshot; fit, evaluate and publish atomically |
| POST | `/score` | Batch up to 10,000 candidates; explicit version or latest via null |
| POST | `/observe` | Idempotent upsert/revoke; serialized fast refit |
| GET | `/evaluation?userId=...&modelVersion=...` | Stored metrics for current/pinned model |
| GET | `/explain?userId=...&exposureId=...` | Original immutable exposure prediction |

All private routes require `Authorization: Bearer <ML_SERVICE_SHARED_SECRET>`. Absent configuration returns 503; invalid token 401; invalid DTO 422; revision/split/identity conflicts 409; unknown models/exposures 404. Error envelopes are `{code,message,retryable}` and never echo credentials/input. Storage/corruption failures return explicit errors, not an empty or secretly reset model.

A scoring candidate can carry `exposureId`. Identical keyed retries return the original prediction even after retraining. Reusing the ID for different features/track or an explicit different model version returns `409 EXPOSURE_CONFLICT`; a failing batch writes no exposure snapshots. A null-version batch containing existing keyed items resolves to their original version for all new items too. Existing exposures from multiple model versions must be sent in separate batches; this preserves a coherent top-level `modelVersion`. Unkeyed requests always score their supplied candidates using the chosen/current model.

The backend records exposure policy, served time, propensity when defensible, input features and returned predictions in Tiger Data. These are not inferred by C1. `/observe` receives completed decisions only; Spotify mutation failure/retry semantics stay with A2. Do not add `split` to ObserveRequest; C1's stable split ledger resolves it.

For C2, `model.transform_context(candidates)` returns a finite matrix; `model.pipeline.feature_names` gives its exact ordered schema. Pin the model version because scales/centroids can change after refit. `predict()` yields the contract dictionaries; `rank()` is the deterministic fallback; `ModelService.register_exposure()` is an internal adapter hook, while HTTP callers should use keyed `/score`. Reward/action-selection logic is deliberately outside C1.

## Storage and operational limits

Each user's directory name is a SHA-256 digest; raw IDs never become paths. Local trusted joblib snapshots contain the fitted model, preprocessing, active feedback, fixed splits, idempotency ledger and metrics. A checksum/runtime manifest accompanies each snapshot; `current.json` publishes it only after writes/fsync. Failed publication retains the previous current version. File locks serialize reads/writes across service instances and processes; pinned model snapshots are never overwritten. A missing current manifest beside existing artifacts fails closed. Recover by restoring a verified complete directory backup, not deleting feedback state.

Treat artifacts as private data and allow writes only from this service/operator. Joblib deserializes Python objects and must never load user-supplied files. Version and exposure history is retained for reproducibility; no retention/compaction policy is implemented. Backups, storage capacity and production multi-replica persistence remain deployment responsibilities. Actual Spotify/SoundNet ingestion, production deployment and real-user model utility have not been tested by C1.
