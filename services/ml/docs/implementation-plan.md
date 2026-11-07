# C1 personalized preference engine implementation plan

Goal: estimate removal preference from explicit per-user feedback, persist adaptive versions, and measure leakage-free performance. Scope is services/ml only; foundation 25a83e4, contracts 1.0.0 / sortfm.features.v1. User authorized independent implementation and commits; no merge.

Architecture: deterministic regularized logistic refits after each labeled change; cold heuristic for fewer than 12 training labels or fewer than 3 per class. Median imputation, scaling and derived similarity fit on training only. Caller-provided taste distances are ignored. Serving models never train on fixed holdouts. JSON feedback ledger and trusted local joblib snapshots persist atomically under a single-writer file lock. HTTP mirrors frozen DTOs; scoring and policy remain separate.

Task 1 — features and preference model (features.py, model.py, tests/test_model.py)
- [x] Write and run failing tests for missing/zero/nonfinite inputs, one-class behavior, determinism, adaptation and no heldout influence.
- [x] Implement FeaturePipeline and PreferenceModel with train-only preprocessing, internal leave-one-out training centroids, uncalibrated logistic probabilities and log-odds explanations; expose transform_context for C2.
- [x] Verify all model tests.

Task 2 — wire DTOs and HTTP (schemas.py, app.py, tests/test_app.py, tests/test_contracts.py)
- [x] Write/run failing typed HTTP and generated JSON Schema compatibility tests.
- [x] Preserve bearer auth/error envelopes; connect fit/score/observe/evaluation/explain to ModelService.
- [x] Verify schemas, validation, user separation and auth behavior.

Task 3 — transactional adaptive state (service.py, tests/test_service.py)
- [x] Write/run failing tests for event idempotency, stale revision, undo, fixed split identity, restart and pinned versions.
- [x] Implement ModelService storage, safe user/version identifiers, per-track labels, split ledger, atomic persistence and immutable scores.
- [x] Verify no update admits holdout labels or overwrites prior versions.

Task 4 — evaluation and reproducible experiments (evaluate.py, cli.py, tests/test_evaluate.py, fixtures, docs)
- [x] Write/run failing tests for insufficient/one-class holdout, fixed identity and reproducibility.
- [x] Implement fixed-holdout metrics, matched ablations, train-size curve, explicit synthetic generator and fixture provenance.
- [x] Run experiments; report measured numbers and limitations, never personal-data claims.

Task 5 — integration, review and handoff
- [x] Review fresh-agent findings and fix substantive issues with regression tests.
- [x] Run Python suite, lock checks, Python build, root Bun tests/typecheck/build, authenticated HTTP smoke.
- [x] Commit only services/ml; document commands, result artifacts, contract gaps, performance and untested production integration.

Review focus: holdout labels/features changing fit; replay/undo across restart; missing/artifact corruption; frozen versions after further feedback; unauthorized/cross-user requests. Each is covered in model/service/HTTP tests.

Interfaces
- PreferenceModel(examples: list[dict], seed: int = 42, feature_group: str = 'personalized'); attributes model_kind, trained_examples; predict(candidates: list[dict], model_version: str) -> list[dict] (trackId/prediction pairs); transform_context(candidates) -> numpy.ndarray; internal feature schema explicit.
- evaluate_model(model, examples: list[dict], model_version: str) -> ModelMetrics dict. Train/holdout examples carry frozen schema; model is already fit exclusively on train.
- ModelService(storage_dir: str|Path); fit(payload: dict), score(payload: dict), observe(payload: dict), evaluation(user_id, model_version=None), explain(user_id, exposure_id), register_exposure(user_id, exposure_id, track_id, model_version, prediction). All return contract dicts. ServiceError(status, code, message) is handled by HTTP. App create_app(shared_secret=None, storage_dir=None).
- CLI can construct PreferenceModel directly for deterministic ablations and persist reports; it must not mix users.

Resolved contract gap: integration-owned c35cd96 (local cherry-pick 3084360) adds optional scoring exposureId. Keyed score now atomically stores immutable predictions and retries original versions; /explain uses those records. No invented endpoint. Candidate lacks artist identity, so artist diversity is impossible at this boundary; offer deterministic feature diversity with optional local artist map in ranking helper. Observe lacks split; assign unseen tracks by stable user+track hash with 20% holdout, persist split forever. Fit permits explicit initial split and seed; later moves/reseeding rejected. Real user labels are absent; synthetic and explicitly authored illustrative labels are not evidence of listener utility.

Verification record: 214 Python tests, 24 TypeScript tests, root typecheck/build, uv lock check/build, installed-wheel CLI and real HTTP restart smoke passed. Independent review found two storage recovery issues; both fixed with failing-then-passing regressions (missing current manifest and structurally corrupt exposure JSON). Added separate-process competing-revision coverage. Root reproduced/fixed duplicate exposure batch index drift. No reviewer findings deferred.

Rulings: keep docs under owned services/ml rather than root docs; preserve original snapshot version for mixed new+retry scoring batches and reject batches spanning multiple existing model versions; add no human-label claims to authored fixtures. Real listener hand-labeled validation remains unavailable, explicitly disclosed. No main merge.
