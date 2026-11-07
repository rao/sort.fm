# C1 integration handoff

Branch: `c1-personalized-ml`. Base: approved foundation `25a83e4`. Includes integration-owned exposure amendment `c35cd96` as cherry-pick `3084360`. All original C1 edits are confined to `services/ml/**`; no merge to main/foundation. Module version `0.2.0`.

## Implemented and verified

Per-user logistic preference learning, fast exact refits after feedback, stable train-only feature transforms, audio missingness and internal taste centroids; cold and one-class heuristics; deterministic feature-diverse ranking helper; log-odds explanations and honestly labeled entropy; immutable model versions and exposure snapshots; serialized per-user feedback ledger, idempotency, revision validation, exact Undo, persistent split identity; authenticated typed HTTP; reproducible training/evaluation CLI; matched ablations, controls, learning curves and reliability bins.

Fresh checks on November 7, 2026:

- `uv run pytest -q`: **214 passed**. Includes auth/contract compatibility, zero/one-class/missing features, leakage, reproducibility, keyed retries, storage corruption, failed publication, restart, Undo and separate-process competing writes.
- `uv run python scripts/smoke_ml.py`: PASS real Uvicorn HTTP auth/fit/score/revoke/idempotency/restart/explain, synthetic data only (131 train labels, available synthetic holdout metrics).
- `uv lock --check`, `uv build`: pass. Wheel and sdist build.
- Installed wheel in an isolated directory with `uv run --no-project --with <wheel> python -m sortfm_ml.cli demo ...`: pass, including packaged authored fixture.
- Root `bun run typecheck`, `bun run test` (**24 passed**), `bun run build`, `git diff --check`: pass. Build retains the two existing nonfatal Zod comment-annotation warnings.
- Independent fresh-agent review: two actionable storage findings fixed with regression tests. Missing current pointer no longer resets established state; malformed exposure structures fail with structured 503 errors. No known reviewer findings deferred.

## Actual results, not performance claims

See `experiments/c1-demo-seed42.{json,md}` and `docs/experiments.md`. Synthetic seed42 has 465 train and 135 holdout labels. Personalized ROC-AUC **0.5990**, PR average precision **0.6083**, log loss **0.6976**, Brier **0.2506**. Age-ranking control ROC-AUC **0.6752**; constant-prior log loss **0.6938**. The personalized model does not beat those controls on those metrics. No holdout tuning occurred.

The explicitly AI-authored fixture changes a probe's removal probability **0.213648 → 0.702318** after **12 → 24** training labels. Its validation metrics are null because it has no holdout. This demonstrates adaptive mechanics only. No human-labeled dataset was provided, so C1's human-fixture/real-listener evaluation acceptance remains unverified; no fabricated substitute is claimed.

`uv run python scripts/benchmark_ml.py --output experiments/cpu-benchmark.json` measured five local arm64 runs: median fit of 100 labels **0.0109 s**, 2,700-candidate score **0.3185 s**, 48 context columns. This is a synthetic local CPU measurement, not an endpoint or deployment SLA.

## Integration decisions and dependencies

1. Configure `ML_SERVICE_SHARED_SECRET`, mount durable POSIX storage and set `ML_ARTIFACT_DIR`. Keep one service replica; same-filesystem workers are supported. README has exact train/evaluate/serve commands. No DB or external provider credentials are needed by C1.
2. Backend sends active, completed feedback, authenticates user identity and logs exposures/policy/propensity to Tiger Data. C1 never performs Spotify mutations. Source provenance/permission flags must remain truthful. Retain frozen train/holdout identity and increasing feedback revisions in full-fit snapshots.
3. Supply optional `exposureId` when scoring an exposure. Retry identical keyed requests to recover the original snapshot. Null modelVersion resolves to existing keyed items' version; new candidates in that batch use the same version. Send already registered exposures from different versions in separate batches (otherwise 409). This is a documented decision where the amended wire contract does not define mixed-version batches.
4. New observe-only tracks use a stable 20% hash holdout and may not enter training. No evaluation numbers before >=20 holdout labels and both classes. Treat current results as exploratory, not accuracy promises.
5. C2 consumes `PreferenceModel.predict`, `transform_context`, `pipeline.feature_names` and `rank`; pin versions when using contexts. C1 adds no contextual-bandit policy. Artist diversity needs artist identity absent from Candidate DTOs and is owned by backend/C2.
6. Integration lead must update root `scripts/smoke-ml.ts`, whose foundation assertions expect capabilities false and routes501. Use the C1 real HTTP smoke as the replacement behavior. Shared root files were not edited by C1.
7. Real Spotify/SoundNet ingestion, production deployment, catastrophic process-kill recovery, prospective evaluation and calibration are untested here. Fault-injected pointer writes, corruption and ordinary restart are tested. Restore verified complete storage backups after integrity failures; never delete user state as an automatic recovery step. Snapshot/exposure retention and disk capacity require an operational policy.
