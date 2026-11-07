# C1 real-feedback calibration

The workflow is executable. Real predictive performance remains **unmeasured**:
the supplied read-only snapshot contains 2,769 candidates and four audio vectors,
and no listener labels have been supplied to this experiment. Historical saves
are not Keep labels. The prepared 60-track session has 40 training tracks and
20 holdouts. None of the 60 happens to have audio; sparse enrichment was not
oversampled to manufacture an audio experiment.

This workflow uses local files only. It never calls Spotify, `/fit`, `/observe`,
review routes, or database mutations. `REMOVE` is a calibration judgment, with
**no archive or unlike operation**. Existing cleanup controls are not a safe
substitute for a label-only workflow.

## Executable workflow

From `services/ml`, install the locked environment with `uv sync --locked`.
Choose a new private directory outside Git, then:

```sh
uv run python -m sortfm_ml.calibration_cli prepare /private/path/library.json \
  --size 60 --sampling-seed 42 --evaluation-seed 42 \
  --output /private/path/calibration-session
```

The native snapshot is `{userId, featureVersion, capturedAt, candidates, display}`.
Candidates use the existing `Candidate` DTO; `display` maps track IDs to
`{title, artists: string[]}`. The integration lead's read-only export is also
accepted: `{snapshotVersion: "sortfm.calibration-export.v1", userId, featureVersion,
capturedAt, assembly, candidates, tracks}`, where tracks contain
`{track: TrackCard, currentStatus}`. Export candidates using the existing full-
library `assembleLibraryCandidates` and live metadata permission/basis. Python
needs no credentials. Freeze the source timestamp and features once.

Fill only `decision` in **train-labels.csv** with honest `KEEP` or `REMOVE`
judgments. Listen/open the recording separately if needed. Do not infer labels
from save dates, model scores, historical Likes, or audio availability. Blank
labels stop fitting; ARCHIVE, UNLIKE and SKIP are rejected. Do not replace
hard-to-label tracks with easier ones that favor a result; report nonresponse.

```sh
uv run python -m sortfm_ml.calibration_cli freeze \
  /private/path/calibration-session/manifest.json \
  --train-labels /private/path/calibration-session/train-labels.csv \
  --run /private/path/calibration-session/frozen-run
```

This fits the predeclared models and saves `models.joblib` plus `frozen.json`:
training counts, coefficients, feature support, and every holdout prediction.
There is no holdout-label input. **After freezing**, fill holdout-labels.csv
without viewing model predictions, then:

```sh
uv run python -m sortfm_ml.calibration_cli evaluate \
  --run /private/path/calibration-session/frozen-run \
  --holdout-labels /private/path/calibration-session/holdout-labels.csv
```

Outputs are `report.json` and `report.md`. Evaluation reads saved predictions,
never refits or loads a live model. Identical retries return the same report;
changed final labels or training inputs cannot overwrite a sealed run. Digests
detect accidental manifest/prediction edits. These are trusted local artifacts,
not protection against an operator deliberately rewriting them. Never load an
untrusted joblib file. Keep all snapshots, sheets, models and reports outside Git.

Future independent validation requires fresh prospective tracks. Changing seeds
after seeing outcomes, or reusing the same holdout in another directory, does
not create fresh evidence. Tune future choices on training-only cross-validation,
before final labels are opened. Probability calibration is not fitted here.

## Sampling and comparisons

Size is configurable from 50–80, with exactly 20 held out. The live SHA-256
`[evaluationSeed,userId,trackId]` modulo-five split is preserved; keep its seed
equal to the API seed. The sampling seed changes selection/presentation only.
Proportional largest-remainder allocation operates within each split across
recency cohorts (`<90`, `90–364`, `365–1094`, `>=1095` days, unknown) crossed with
two musical bins. Energy/danceability are used when each has >=50% coverage;
release age/duration fill absent axes. Boundaries use unlabeled candidate medians.
Ties and within-cell shuffling are seeded over canonically ordered tracks.

The manifest includes population/selection counts per cell and audio counts.
Small cells can receive zero selections. This is approximate proportional
representation, not coverage of every artist/style. No model-driven sampling or
post-label balancing occurs. Default seed42 real sample recency counts are
1 / 6 / 20 / 33 in the four known-age cohorts; train/holdout totals are 40 / 20.

All models use the same fixed training/holdout tracks:

- `training_prior`: constant observed training removal fraction.
- `age_only`: existing logistic implementation with saved age only.
- `metadata_only`: release age, duration, artist-library count.
- `metadata_history`: metadata plus saved age and available listening proxies.
- `c1`: existing personalized C1, with supported audio and train-only centroids.
- `audio_enriched`: metadata/history plus audio, gated as described below.

The audio comparison requires >=24 covered training examples (>=6 per class)
and >=12 covered holdouts. A covered row needs >=3 descriptors that each have
>=12 training observations and >=3 from each class. Holdout labels never decide
eligibility. These are engineering gates, not power guarantees. The report gives
per-descriptor support and defers an experiment with no usable audio predictors.

The audio experiment compares identical full holdouts and identical audio-covered
subsets. Compare with `metadata_history` to isolate added audio and with
`metadata_only` for the broader contrast. Subset size and positives are explicit.
Nothing chooses a winner or retrains from final performance. Four enriched tracks
do not support the experiment; report deferred until a prospective snapshot has
sufficient coverage. Do not refresh an already labeled holdout's features to
search for a better result.

Wire `ModelMetrics` preserves its existing >=20 holdouts/both-class gate and null
unavailable values. Separate report diagnostics expose log loss/Brier when valid
even with one class. ROC-AUC is null for one class; AP/recall/lift/NDCG are null
without Remove labels. Ranking includes actual k, precision, recall, lift,
average precision, and NDCG. Precision/recall ties use track ID; NDCG averages
ties. Small-subset figures never inherit full-set availability. Metrics describe
this sampled cohort without population weighting and remain exploratory.

## Missing audio, old models and C2

New fits retain C1's regularized logistic architecture and train-only robust
preprocessor. Missing-indicator classifier coefficients are zero, so correlated
provider-availability flags cannot masquerade as musical preference. Each audio
value/centroid needs >=12 observed training rows and >=3 of each class. Unsupported
audio also disables centroid predictors that could carry its signal indirectly.
Missing values use training medians; observed zero stays zero. Residual coverage
bias remains possible; losing real audio can still change a prediction.

Existing feature-group order, feature names and `transform_context` are unchanged.
The classifier mask does not alter C2 coordinates. New fits include recipe
`c1-logistic-supported-values-v2` in model version identity. Old artifacts without
the mask retain their exact original scoring, even their old missingness effects.
Runtime manifest format stays compatible; identical old fit retries return the
old version. A new feedback revision produces a model with the new recipe.
Immutable old explanations remain unchanged. No live migration/restart occurred.

## Integration and inspector mapping

No shared DTO/route changed. The integration lead owns any public additions.

| Inspector content | Local report field |
|---|---|
| Actual train/holdout class counts | `counts` |
| Frozen model identity | `models.c1.modelVersion`, `frozenDigest`, `recipe` |
| Existing inspector metrics | `models.c1.metrics` (unchanged ModelMetrics) |
| Baselines and ranking | Each model's `metrics`, `diagnostics`, `ranking` |
| Learned associations | `contributions`: coefficient, mean absolute training contribution, enabled |
| Audio adequacy/subsets | `audioExperiment`, `audioPairedComparison` |
| Protocol/limitations | `sampling`, `protocol`, `limitations` |
| No judgments yet | `pending-report.json`: actual counts zero and null metrics |

Offline versions are not live service versions. Do not show the offline report
as the current queue model or publish CSV models into live owner storage. The next
DB feedback fit would discard labels absent from persistence. Integration must
first persist calibration labels and immutable feature/split identity in the
unified revisioned snapshot, including Undo/replacement semantics, without Spotify
writes. Then ordinary retraining can consume them. Preserve frozen evaluation
predictions separately from online scores; repeated online evaluations are
exploratory rather than untouched final validation.

## Verification

Tests cover deterministic strata/seeds, exact split counts, strict matching CSVs,
missing/one-class data, frozen predictions, sealed retries, no evaluation refit,
online holdout isolation, sparse/complementary audio coverage, availability-only
artifacts and legacy nonzero missingness coefficient preservation. CLI tests run
all phases with synthetic labels. Synthetic checks establish mechanics, not real
listener performance. Reproduce with:

```sh
uv run pytest -q
# from repository root
bun run typecheck
bun test
bun run smoke:ml
```

Final verification: **432 Python tests passed**, including C2 and 16 new checks;
root typecheck passed; **520 TypeScript tests passed** (68 environment-gated skips,
2,694 assertions); the authenticated temporary **C1 HTTP/Zod smoke passed**.
Independent review identified and confirmed the fix for class-disjoint audio
coverage incorrectly passing the experiment gate. No remaining review finding.

In the restricted agent environment, tests used the installed locked environment
via `UV_CACHE_DIR=/tmp/sortfm-uv-cache uv run --no-sync`. HTTP tests required
permission for local loopback sockets. Private real files are not committed.
