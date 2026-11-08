# Offline research sampling reference

`sortfm_ml.research_sampling` creates a replayable plan from caller-supplied
snapshots. It performs no network, database, fitting, feedback, live queue, or
promotion operations. Its private research schema does not change shared DTOs.

The cross-stack Calibration Batch 2 implementation belongs to its integration
owner. Recipes here can inform that work; wiring, role persistence, label
handling, queue behavior and shared contracts require coordination with that
owner. This module is not an implementation of that flow.

## Input boundary

`prepare_sampling(snapshot, role_registry, ...)` accepts these inputs:

- `snapshot`: `userId`, `featureVersion`, `capturedAt`, and `candidates` containing
  the existing `{trackId, features}` shape. Features retain provenance,
  `permittedForTraining`, optional rights basis, missingness and zero values.
  Extra label fields, invalid numbers, unsupported features and duplicate tracks
  fail validation. Real and synthetic candidates cannot be mixed.
- `role_registry`: the **complete authoritative history**, including tracks no
  longer in the snapshot. Each record has `trackId`, `revision`, `split`
  (`train` or `holdout`), `role` (`training` or `evaluation`), and `feedbackState`
  (`unlabeled`, `active`, `revoked`, or `superseded`). A `(trackId, revision)` is
  unique. All records for a track must retain its original split and role.
  `train` requires `training`; `holdout` requires `evaluation`.
- `excluded_track_ids`: tracks with known current labels, or other
  tracks excluded from this batch. Current active/superseded registry states
  are automatically excluded too. This argument does not replace label history.
- `pinned_predictions`, required for uncertainty: `modelVersion`, SHA-256
  `modelDigest`, learned `modelKind` (`logistic`, `sgd_logistic`, or `tree`),
  `trainingTrackIds`, `featureVersion`, `sourceDigest`, and `predictions`.
  Each prediction has `trackId`, `featureDigest`, and `removalProbability`.
  All training lineage tracks require registry entries and must have the fixed
  training role. Every eligible training candidate needs a finite probability
  in `[0, 1]` when uncertainty sampling is requested. Heuristic scores are not
  accepted as probabilities. `snapshot_digest(snapshot)` obtains the validated,
  track-sorted snapshot digest. `content_digest(features)` obtains each feature
  digest; canonicalize features through the existing `Candidate` schema first
  when numeric JSON representations differ.
- `evaluation_size`, `representative_size`, `diversity_size`, `uncertainty_size`,
  `sampling_seed`, and `exploration_probability` (default `0.1`, allowed range
  `[1e-6, 1]` to retain positive support in floating point). Requested
  counts must fit the eligible pools; the module never silently fills shortages
  by borrowing another role.
- `previous_manifest`: required by the caller's protocol for every subsequent
  round. The earlier registry must be retained unchanged, including tombstones.
  All earlier selected tracks remain reserved and excluded, cumulatively, even
  when tracks leave the snapshot. A changed snapshot creates a new data identity;
  prediction pins must match that identity.

The first authoritative export must retain the earliest-ever persisted split
and all feedback history. This module cannot discover deleted history, verify
that an external artifact actually matches a claimed model digest, or recover
an omitted previous manifest. Those checks belong to the authoritative exporter
and experiment owner. Hashes detect local edits; they are not signatures.

## Roles and evaluation use

Evaluation draws come only from permitted **never-labeled fixed holdout** tracks.
Any historical active, revoked or superseded feedback excludes that track from
the new evaluation pool. A revoked holdout cannot become a training example.
Any earlier viewed/labeled holdout is monitoring evidence and cannot be called
a newly sealed panel. Existing training tracks cannot be promoted to evaluation.

Training representative, diversity and uncertainty draws use only permitted
fixed training tracks. Evaluation features do not determine training strata,
normalizers, probabilities or draws. The module never reads labels, fits
preprocessing, or trains a model. Downstream callers must preserve these role
boundaries: evaluation responses must never become training examples, taste
centroids, model selection data or uncertainty updates. Freeze model/protocol
before obtaining new evaluation labels and retain a separate sealed label store.

## Selection and probability meaning

The order within a batch is representative evaluation, representative training,
diversity training, then uncertainty training. Every draw is without replacement;
the training strategies compete for a shared remaining training pool. Each
strategy has a separate SHA-256-derived seed stream. Predictions and adaptive
batch sizes do not change representative selections for the same pool and seed.

Representative strategies use simple random sampling. If their initial eligible
pool has `N` tracks and their requested batch has `k` tracks, draw `j` has
conditional probability `1 / (N - j + 1)` and marginal inclusion probability
`k / N`. These describe the eligible fixed split pool for this round, after
exclusions and prior reservations. They do not claim a full-library probability
or account for a historical hash split as if it were fresh random assignment.

For adaptive strategies and remaining set `R`, the conditional probability is:

```text
p(i | history) = epsilon / |R| + (1 - epsilon) * score(i) / sum(score)
```

When all scores are zero, the acquisition component is uniform. Exploration is
positive so every remaining eligible track has support. Uncertainty score is
binary entropy of the frozen removal probability (base 2). Diversity score is
`1 / (remaining tracks in this stratum * (1 + earlier selected tracks in this
stratum))`. Earlier representative training draws count toward that coverage.
Fixed strata use saved age boundaries `90/365/1095` days, release age `2/10`
years, energy `0.5`, and danceability `0.5`; missingness is its own bin. No
evaluation statistics or labels determine those boundaries.

Each selected row records its conditional probability, exploration component,
score and score total, pool size, RNG draw, feature digest, immutable features,
strategy and role. The full conditional-distribution digest is also retained.
`marginalInclusionProbability` is **null** for adaptive rows: the conditional
draw probability is not a batch inclusion probability and must not be used as
a marginal inverse-probability weight. Strategy comparisons need predeclared
budgets and an appropriate evaluation protocol; batch ordering alone is not a
randomized comparison of learning strategies.

## Manifest and replay

The manifest embeds normalized inputs, full provenance, prediction/model/data
identities, original role history, prior manifest, cumulative reservations and
the sampling plan. `offlineOnly=true`, `promotionAllowed=false`, and
`evaluationFeedbackForTraining=false` identify its intended boundary.
`validate_sampling_manifest` checks its version and content digest.
`replay_sampling` additionally reruns the pure sampler and rejects any mismatch.
Keep manifests private alongside the authoritative exports; this module does
not write files or change permissions itself. Multi-round manifests embed their
predecessor, so they retain replay history rather than referring to mutable paths.

For a proposed 25/25/20 recipe, use `evaluation_size=25`, `diversity_size=25`,
`uncertainty_size=20`, with a frozen learned prediction bundle and at least 25
never-labeled holdout / 45 eligible train candidates. A separate representative
training baseline uses `representative_size` under its predeclared budget.
Shortage is an explicit error. These are configurable research examples, not
instructions to change the live calibration batch or expose evaluation labels.
