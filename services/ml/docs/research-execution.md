# Reproduce C1 research privately

This branch adds an offline research library and CLI under `services/ml`.
It does not change serving code, ranking, feedback, database schemas, or shared
contracts. Do not deploy this experiment or load a research model into production.
The existing production `uv sync` groups do not install the optional plotting group.

## Run

From `services/ml`, using an operator-created private frozen diagnostic package:

```sh
UV_CACHE_DIR=/private/tmp/sortfm-research-uv uv sync --frozen --group research
MPLCONFIGDIR=/private/tmp/sortfm-research-mpl \
  UV_CACHE_DIR=/private/tmp/sortfm-research-uv \
  uv run --frozen --group research python -m sortfm_ml.research_cli \
  --package /absolute/private/operator-package \
  --output private-data/research-run-001 \
  --trusted-local-artifact
```

The explicit trust flag permits local joblib deserialization. Checksums prove byte
integrity, not trust: never pass an uploaded or untrusted pickle/joblib. Without
the flag the JSON benchmark still runs, but pinned-model diagnostics and the
uncertainty sampling proposal are unavailable. No network calls occur in the CLI.
It never calls `/fit`, `/observe`, a database writer or an enrichment provider.

The input package schema follows the private read-only integration export:

- `database-snapshot.json`: `snapshot` includes owner, matched revisions,
  trainingExamples, exact original exposure labelContexts, effectiveFeedback
  including tombstones, current library/candidates and calibration eligibility;
  `evaluation` is the deployed pinned model's evaluation response.
- `database-verification.json`: `snapshotSha256`.
- `model/pinned-state.json`: exact active examples, split ledger, owner and revision.
- With trusted model loading: `INDEX.json` names the pinned model/manifest and
  version/revision; the manifest contains artifact SHA-256 and numerical runtime.

Treat the package as private. Do not substitute generated labels or title-derived
preferences for human feedback. The current export does not contain a complete
historical event ledger; it supports a current-state audit, not proof over every
past revision. A new prospective sealed panel must not enter this research export
before its separately frozen final-evaluation protocol permits access.

## Outputs

The output must be a new directory beneath ignored `private-data/`; existing runs
are never overwritten. Parent traversal and symlink destinations are rejected.
Directories are `0700`, files `0600`. Keep the entire output private, including
aggregates: track-level predictions, preference labels, source snapshots and
sampling pools are sensitive. Check `git check-ignore` before any manual copy.

- `report.md`: diagnostics, comparisons, limitations and recommendations.
- `results.json`: complete metrics, intervals, raw private fold/OOF predictions,
  counts, audio ablations and learning curves.
- `benchmarks.csv`, `feature-weights.csv`: reusable numerical tables.
- `plots/*.png` and `plots/*.svg`: dataset audit, benchmark uncertainty, reliability,
  score distributions, feature contributions and learning curves.
- `inputs/`: frozen original package and original/audio-derived labeled vectors.
- `implementation/`: exact Python implementation, lockfile, project metadata and
  research documentation used for the run.
- `sampling-reference.json`: offline representative/diverse/uncertain proposal.
  It makes no live reservation and is **not** an instruction to collect another
  production batch. Coordinate any integration with the existing Batch2 owner.
- `manifest.json`: SHA-256 for every other output file.

Re-run using a new output directory and the preserved `inputs/` package. Keep the
same frozen implementation/lock/runtime, seed and repeat count. Metrics, folds,
predictions and sampling selections should match exactly in the same numerical
runtime. Generation timestamps, timings, SVG metadata and font rendering may differ.
`results.json` records exact source hashes even when the working tree is uncommitted.

## Protocol

`run_benchmarks` fixes all recipes and folds. It uses five repeated stratified CV
passes on `split=train` only. It separately evaluates the fixed historical
monitoring holdout; these labels are already inspected, not a new final test.
Preprocessing and centroids fit only the fold training data. Small or one-class
training falls back explicitly to its class prior; unsupported metrics stay null.

Primary metrics are fold-macro ROC-AUC, average precision (non-interpolated PR
summary), log loss, Brier, tie-aware precision@k and NDCG@k. Resampling clusters by
track across repeats. Conditional bootstrap intervals do not refit models and do
not account for selection/session/artist dependence or training-set variation.
P@k uses min(k, fold size); it cannot imply whole-library cleanup utility.

The audio derivative changes only audio keys. An invariant verifies E2 predictions
and all evaluation fold IDs remain identical. It is retrospective, not a recreation
of what the user or model could observe when the label was recorded. Same-population
subgroup results and paired contrasts prevent comparisons of mismatched cohorts.

Learning curves keep evaluation tracks fixed. An oracle balanced seed is followed
by chronological additions within each training fold. Same-SGD incremental and
full replay execute identical updates; their matching predictions validate update
semantics and saved work. E2 metadata/history and full C1 batch are separate optimizer/preprocessing references. Paired first-to-last loss contrasts and conditional track-bootstrap bands report learning-curve uncertainty.
This experiment does not simulate the unseen labels a new active-learning policy
would have collected or prove prospective adaptation.

## Tests

```sh
UV_CACHE_DIR=/private/tmp/sortfm-research-uv uv run --frozen --group research pytest -q
```

From repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
UV_CACHE_DIR=/private/tmp/sortfm-research-uv bun run smoke:ml
git diff --check
```

Database/network integration tests are environment-gated. Do not point tests at
the production owner database merely to turn skipped checks green. Tests exercise
split/label perturbation isolation, train-only transforms, equal populations,
bootstrap repeat dependence, tie handling, exact C1 recipes, audio immutability,
artifact identity, private output boundaries and sampling lineage/replay.

## Handoff

Read `research-leakage-audit.md`, `research-sampling.md` and
`c2-evaluation-proposal.md`. Production changes require integration-lead review.
The live Batch2 implementation is owned elsewhere. This reference keeps existing
fixed splits and adds stricter role/provenance checks locally; it does not define a
replacement shared DTO or migration. Final evaluation labels never become training
examples through this harness.
