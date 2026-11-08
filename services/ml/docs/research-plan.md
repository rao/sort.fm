# C1 empirical evaluation protocol

Scope: offline experiments under `services/ml`; production ranking, API/DB contracts,
feedback delivery, and deployed artifacts are unchanged. Raw human data and all
derived reports remain in ignored `private-data/` with restrictive permissions.
This protocol is fixed before benchmark outcomes are computed. It is an exploratory
research plan, not a registered confirmatory analysis.

1. Verify a consistent private database export against its SHA-256 and the pinned
   deployed model/state. Audit labels, source, timing, features, split identity,
   missingness and selection mechanism. Retain the immutable original exposure
   vectors and a separately versioned audio-only retrospective augmentation.
2. Use repeated stratified cross-validation on **training-assigned tracks only**
   for E0 class prior, E1 age, E2 C1 metadata/history, E3 plus audio, E4 small fixed
   boosted trees, and E5 smoothed nearest neighbors. Fit preprocessing inside each
   fold. Reuse identical evaluation tracks and folds. No hyperparameter search.
   Preserve repeat-level metrics; intervals cluster by track and are descriptive,
   conditional on this small, selected cohort. Existing holdout is a monitoring
   set, not an untouched final test; score it once after fixed recipes, do not tune.
3. Compare original features with an audio-only augmentation from the pinned
   current snapshot, leaving save age, metadata, and listening windows unchanged.
   Compare E2/E3 on identical populations, including an explicitly secondary
   audio-covered subset. Keep missingness/coverage diagnostics and population sizes.
4. Plot held-out/CV score distributions, reliability diagrams, weights and exact
   additive feature contributions, save-date/coverage distributions, and learning
   curves. Training scores are marked resubstitution; they are not efficacy proof.
   Error examples use opaque local row aliases; raw track identities never enter Git.
5. Learning curves evaluate unseen CV tracks as training labels accumulate. Compare
   C1 batch fits and true incremental SGD against SGD replay with matched model
   family and frozen warm-start preprocessing. This is retrospective evidence and
   cannot estimate the causal benefit of a new acquisition policy.
6. Implement an offline sampling manifest: representative random evaluation panel,
   representative training, diversity and uncertainty training draws. Fixed split
   and role registry survives revocation; model-selected rows are never evaluation.
   Log exact conditional draw probabilities, not invented marginal propensities.
7. Test duplicate/invalid inputs, train-only feature fitting, holdout-label
   perturbation invariance, shared evaluation populations, snapshot integrity,
   sampler replay/probabilities and role protections. Run full Python regression,
   root typecheck/tests and ML smoke. Review before a scoped commit.

Do not infer representative population utility from a selected feedback sample.
Do not claim audio improves generalization from partial enrichment or small samples.
Do not calibrate probabilities or choose a model using the final monitoring labels.
Any proposed deployment or shared sampling contract needs integration coordination.
