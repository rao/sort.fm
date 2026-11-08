# C1 research leakage and data audit

Audit date: 2026-11-07. Scope: source inspection and local regression tests.
This document contains source-code findings only. Real-listener observations
belong in the ignored private research report. No database connection, provider
request, serving-model change, queue change, or contract change was made.

## Conclusions

C1's current fitting implementation excludes holdout labels **and holdout feature
statistics** from fitting, imputation, scaling, descriptor support, and taste
centroids. This prevents direct training contamination through those paths. It
does not make the selected, repeatedly evaluated online holdout a sealed final
test set or establish predictive utility.

Saved age is not forced to dominate supervised C1: its sign and coefficient are
learned. Sparse audio and absent listening history can give metadata more complete
evidence. Whether age dominates any fitted artifact must be measured privately;
training coefficients and contributions cannot establish held-out gains or
causal importance.

## Protections that are implemented

| Boundary | Implementation and evidence |
|---|---|
| Train-only fitting | `src/sortfm_ml/features.py:51` filters to permitted binary `train` rows. `model.py:34` filters before any feature fitting. `FeaturePipeline.fit_transform`, `features.py:116`, rejects non-training rows; medians/IQRs and audio scaling use only these rows. |
| Supervised centroids | `features.py:128` constructs label pools from train rows. `features.py:157` removes every occurrence of the target track from its own class pool. Caller-supplied centroid fields are excluded from raw base columns (`features.py:95`), then constructed internally. Holdout candidates only transform against the stored train pools. |
| Audio support and missingness | `model.py:42` masks all missing-indicator predictors. Descriptor support is measured only in training, with at least 12 observed rows and three per class; unsupported nonempty audio also disables centroid predictors (`model.py:45-59`). Zero remains an observation (`features.py:39`). |
| Track isolation and fixed split | `/fit` rejects duplicate tracks/decisions and split changes; split and decision ledgers persist independently from active examples (`service.py:173-200`). `/observe` assigns new tracks from seed/owner/track only, retains existing assignment, and refits through the same train-only model (`service.py:277-315`). |
| Revision consistency | Same-revision identical fits replay; conflicting/stale revisions and changed evaluation seeds fail (`service.py:180`). Event replay is fingerprinted before stale-revision checks (`service.py:282`). Revoking an old superseded decision does not erase its newer replacement (`service.py:297`). |
| Database feedback | `packages/db/migrations/012_calibration.sql:21-32` unifies cleanup and calibration, chooses the latest row including null/revoked tombstones, then filters active labels. Training features come from the original exposure payload. `packages/db/src/repository.ts:150` reads examples and owner revision under one owner lock. |
| Durable synchronization | Calibration writes labels/revocations, owner revision, and outbox together (`packages/db/src/calibration.ts:33,46,58`); cleanup does the same (`packages/db/src/repository.ts:102-111`). `apps/api/src/ml/repository.ts:25` forwards the complete snapshot without reconstructing features; `apps/api/src/reviews/feedback.ts:23` acknowledges only a fit at least as new as the claimed revision. |
| Immutable serving context | Keyed scores fingerprint feature/track identity and pin model version (`service.py:228-274`). DB exposure rows preserve full features, prediction, policy, and served time; queue insertion completes before cards return (`apps/api/src/calibration/queue.ts:53-64`). |
| Artifact publication | Per-owner filesystem locking, checksummed numerical-runtime manifests, atomic replacement, and a final current pointer protect published snapshots (`service.py:49,71,93,121`). Missing/corrupt existing state fails explicitly rather than silently cold-starting. |
| Evaluation gate | `evaluate.py:80` rejects duplicate identities; `evaluate.py:106-114` requires at least 20 holdouts, both classes, and a fitted probability model. Below these gates, wire metrics stay null. |

## Remaining research limitations and failure modes

1. **Online holdout access is not sealed.** Every model publication evaluates the
   latest active holdout (`service.py:136-138`), and `/evaluation` exposes it
   (`service.py:318`). Holdout labels can be revised, removed, or replaced while
   their track split remains fixed. Repeated model, feature, threshold, or
   cohort choices informed by these results turn this into a development set.
   Use training-only inner folds for selection and a new prospective frozen
   cohort for a final claim. A new directory or seed alone does not make already
   inspected labels fresh evidence.

2. **Initial split assignments are trusted.** `/fit` accepts caller-supplied splits
   for previously unseen tracks (`service.py:190`); it does not re-derive the hash.
   This supports the frozen contract but means a newly initialized research
   directory can accept mislabeled split metadata. Validate all imported splits
   against the experiment manifest and historical split ledger before fitting.
   `/observe` permits a jump to any newer revision; missed events can omit labels.
   The production snapshot-fit outbox avoids depending on complete incremental
   delivery. Do not combine `fit` and `observe` for the same revision.

3. **Source-level split inheritance is inductive, not a complete history audit.**
   Calibration inherits the latest effective row's split (`calibration.ts:54`);
   cleanup also inherits the latest effective row (`repository.ts:111`). Neither
   query explicitly searches the earliest ever assignment despite that normative
   requirement in `docs/contracts.md`. It is stable when preceding writes are
   consistent. Legacy, imported, or manually
   inconsistent history should be audited instead of assuming latest equals
   earliest. An export containing only latest feedback and a split ledger cannot
   prove all historical transitions.

4. **Selection is informative.** Online calibration round-robins save-age quartiles
   and favors primary-artist diversity (`apps/api/src/calibration/selection.ts:8`).
   Cleanup uses model-ranked removal scores (`apps/api/src/reviews/queue.ts:93-98`).
   Neither is a probability sample; propensities are correctly null. Eligible
   calibration excludes active feedback, nonmembers, unplayable tracks, and
   pending workflows (`packages/db/src/calibration.ts:36-39`). Label completion
   and client-local skipping add selection. Holdout metrics describe completed
   judgments in this process, not unbiased whole-library performance. No
   inverse-propensity estimate is defensible from these records alone.

5. **Feature availability and time need explicit treatment.** Original exposure
   snapshots prevent replacing predecision features with outcome-derived values.
   Artist counts use the full then-current library, including unlabeled holdout
   tracks (`apps/api/src/ml/features.ts:52-69`): this is label-free library context,
   appropriate for predicting other tracks in that library, not an estimate of
   performance on unseen libraries. Later cleanup changes the context of later
   exposures. Retrospective current enrichment and temporal evaluation answer
   different questions and must not be mixed silently.

6. **Track-level splitting does not establish artist-level transfer.** Different
   tracks by one artist may occur in both splits. That is legitimate for the
   stated within-library track task. Claims about new artists, future sessions,
   or new listeners require the relevant grouped or temporal outer split. Every
   validation fold must fit its own entire feature pipeline, including support,
   imputation, scaling, and centroids; preprocessing once on all labeled rows
   before cross-validation would leak validation labels through centroids.

7. **Artifact version and source version are different evidence.** New fits hash
   `MODEL_RECIPE` into identity (`service.py:127`), but loads validate numerical
   runtime, checksum, owner, and version—not the currently requested recipe
   (`service.py:110`). `model.py:127-129` deliberately preserves old artifacts
   without predictor masks. A code upgrade or identical `/fit` retry does not
   retrofit their coefficients. This is compatibility behavior, not contamination;
   export mask/support state and recipe evidence with any result. Inspect the
   actual pinned model before attributing behavior to legacy or current semantics.

8. **Current feedback tables are not a complete append-only label history.**
   Calibration Undo changes the existing label's label/revision/time
   (`calibration.ts:65`); cleanup settlement upserts feedback
   (`repository.ts:111`). Original calibration `submitted_label` and Undo commands
   survive, but the mutable effective view is insufficient to reconstruct every
   arbitrary historical revision. Immutable fitted artifacts preserve the
   snapshots that actually fitted; coalesced outbox revisions need not each have
   an artifact. Explicit research event/snapshot storage is needed for reliable
   revision-to-revision scientific comparisons.

## Existing sealed local calibration flow

`calibration.prepare` freezes label-blind strata and split assignments before
labels (`calibration.py:79-140`). Its strata use all candidate covariates; this is
sampling design, not model preprocessing. `calibration_run.freeze` accepts only
training labels and writes predictions for all selected holdout tracks before
reading their labels (`calibration_run.py:88-143`). Evaluation reads those saved
predictions without refitting, and changed final labels are rejected after the
first evaluation (`calibration_run.py:197-209`).

These are useful mechanical protections, not proof that the operator had never
seen holdout labels. Both blank sheets are created during preparation
(`calibration_cli.py:32`); code cannot prevent early external labeling or new
experiments informed by earlier results. The audio comparison gate observes
holdout feature coverage, not holdout labels (`calibration_run.py:52`); report this
predeclared coverage-conditioned scope. Fixed 20-row final testing is an
engineering gate, not a power calculation or guarantee of precise improvement.

## Research data schema guidance

Keep the research format private and separate from production DTOs. Existing
frozen feature and HTTP contracts need no modification to support these local
artifacts. Prefer an explicit schema version and immutable content digests.

| Record | Minimum research fields and rule |
|---|---|
| Experiment manifest | Experiment ID, creation/freeze times, source snapshot digest, owner pseudonym, target population/estimand, label meaning, inclusion/exclusion and sampling rules, fixed split method/seed, grouped entities if applicable, predeclared model families/metrics, final-test access status. |
| Membership/split ledger | Experiment ID, pseudonymous track ID, immutable split, first assigned revision/time, source of assignment, exclusion reason, artist/group key if needed. Retain revoked/inactive identities. Validate duplicates and cross-split overlap before every run. |
| Feedback event | Event/label pseudonyms, track, source (`calibration`/`cleanup`), submitted label, effective label/state, owner feedback revision, happened/recorded times, supersedes/revokes reference, idempotency digest, exposure reference. Append events; never encode missing/skip/undo as Keep. |
| Exposure feature snapshot | Exposure/track pseudonyms, served time, immutable feature values and missingness, feature version, source/provider and feature-fetched times when available, training permission, selection policy/version, position, actual viewed status when measured, candidate-population digest, nullable true propensity, pinned prediction/model reference. Never infer viewed from served. |
| Dataset snapshot | Exact active feedback revision, ordered label-event and exposure references, immutable feature digests, split ledger digest, source/export checksums, export time, class/coverage counts. Freeze the latest-event projection including tombstones before excluding inactive labels. |
| Model run | Dataset digest, code commit, recipe and package/runtime versions, train IDs/digest, fitted preprocessing/support/centroids, random seeds, hyperparameters, inner-fold manifests, artifact checksum, fit time. No final-test values used in any fitted statistic. |
| Prediction/evaluation | Model/run and dataset IDs, immutable held-out row IDs, prediction time, full out-of-fold/final predictions, threshold/k, metric definitions, paired uncertainty/resampling method, sample/class counts, comparison scope, all tried configurations, test-access record, limitations. |

Keep raw exports, identity mappings, and real-listener aggregate reports outside
Git. Only publish synthetic examples and source-code findings unless the user
explicitly authorizes sharing private data. The service already treats
joblib as trusted operator data, not an upload format, and keeps snapshot history;
it has no retention/compaction policy (`services/ml/README.md:124-126`).

## Verification

Ran the existing local model, service, calibration-model, evaluation, and
calibration suites: **78 passed**. Command from `services/ml`:

```sh
UV_CACHE_DIR=/private/tmp/sortfm-audit-uv uv run --offline --frozen pytest -q \
  tests/test_model.py tests/test_service.py tests/test_calibration_model.py \
  tests/test_evaluate.py tests/test_calibration.py
```

The suites ran against the original checkout before the audit moved to the
isolated research checkout; all 12 relevant source/test files were byte-compared and
matched in the research checkout. DB-backed tests were inspected, not run; no
database was contacted. No preexisting diagnostic source/test files were edited.

Relevant regression coverage includes `test_holdout_values_labels_and_unpermitted_examples_cannot_affect_fit`,
`test_supplied_centroid_distances_are_never_trusted`,
`test_train_centroids_exclude_target_and_missing_masks_are_always_present`,
`test_audio_gate_ignores_holdout_features_and_labels`,
`test_holdout_is_never_added_to_training_by_observe`,
`test_undo_removes_train_label_and_keeps_split_identity`,
`test_superseded_decision_undo_does_not_erase_new_label`,
`test_frozen_run_evaluates_without_refit_and_seals_final_labels`, and
`test_legacy_model_without_mask_retains_predictions_and_context`.

DB tests at `packages/db/test/calibration.test.ts:12,34,47,58` cover exposure
features, outbox/Undo/relabel, cross-source supersession, concurrency, and rollback.
`apps/api/src/ml/repository.test.ts:13` covers immutable exposure-time forwarding.
These tests support the listed protections; none establishes causal feature
importance, population representativeness, final-test nonaccess, or enough human
labels for a reliable accuracy claim.
