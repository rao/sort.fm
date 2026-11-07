# C1 real-feedback calibration implementation plan

Goal: collect 50–80 genuine Keep/Remove judgments without Spotify writes and
measure fixed C1 models on a sealed 20-label holdout. The user's eight requested
deliverables are the specification. Work is restricted to `services/ml`.

Architecture: reuse FeaturePipeline, PreferenceModel, shared input validation,
split hashing and ModelMetrics. Add an offline prepare → freeze → evaluate CLI.
Keep all listener files private; never promote a result automatically. Shared
DTO changes and inspector wiring belong to the integration lead.

Decisions: default 60 labels (40 train / 20 holdout); proportional stratification
by save-age cohort and available audio energy/danceability, with release era and
duration fallback; separate sampling and existing evaluation seeds. Freeze
features, protocol, training coefficients and all holdout predictions before
accepting holdout labels. No final-holdout model selection or tuning.

1. Add regression tests for missingness-only prediction, sparse audio and legacy
   model reload. Mask unsupported audio and missing-indicator classifier inputs,
   preserving C2 context layout and old model semantics.
2. Add sampling and local label CSV tests: 50–80 unique tracks, exactly 20 hash-
   assigned holdouts, deterministic order-independent randomization, strata
   counts, no label inference, incomplete/duplicate/foreign-label rejection.
3. Add freeze/evaluation tests: mutate holdout labels and online state without
   changing trained parameters/predictions; idempotent final report, reject
   changed final labels; age-only and metadata controls, gated audio experiment,
   real metrics, contributions and insufficient-data reporting.
4. Implement CLI, read-only snapshot export and handoff. Verify on a real private
   snapshot when available; do not fabricate listener decisions. Run complete
   Python/C2 suite, root typecheck/tests and ML HTTP smoke. Request independent
   whole-branch review and hand the focused commit to integration.

Review focus: empty/one-class feedback; audio present only in one label class;
tampered or cross-user files; reversed input ordering/tied scores; previously
persisted models/explanations and fixed C2 feature coordinates.

Ruling: execute directly within the user's detailed implementation authorization;
no extra design approval or changes to shared contracts are necessary.

Completed all four tasks. A private integration-provided snapshot was used for
read-only preparation (2,769 candidates, four audio vectors, no labels inferred).
No exporter or shared-contract edit was needed: the CLI accepts that export.
Independent review found and verified the fix for an audio gate that counted
class-disjoint descriptors as usable coverage. Regression failed before the fix.

Final validation: 432 Python tests including C2 passed; root typecheck passed;
520 TypeScript tests passed (68 environment-gated skips); authenticated temporary
C1 HTTP/Zod contract smoke passed. Local socket tests needed sandbox escalation.
All listener data and generated blank sheets remain outside Git. Real predictive
metrics await the listener's labels; no live service/model promotion occurred.
