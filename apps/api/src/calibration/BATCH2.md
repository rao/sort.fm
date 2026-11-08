# Calibration Batch 2 handoff

Batch 2 extends the existing calibration-only screen, exposures, labels, Undo and feedback outbox. It collects **70 additional preferences: 25 sealed evaluation, 45 training**. No C1 architecture, evaluation experiments, C2 policy, or Spotify mutation implementation changes.

## Sampling and frozen provenance

Algorithm `calibration-batch2:v1`, default seed `42` (configurable before creation). The owner has one durable `calibration-batch2-v1` session. Repeated creation resumes it; requesting a different seed directly returns 409. The server excludes every track with **any historical calibration label or cleanup decision**, including revoked/tombstoned/failed history, plus all prior batch reservations. This is stricter than the ordinary queue's active-label exclusion. It rechecks selected tracks under the owner lock before committing anything.

- **A — 25 random, sealed evaluation.** SHA-256(seed, group, track ID) supplies a reproducible permutation. Membership is independent of predictions, feature values, audio availability and input ordering. No artist or age balancing is applied to this group. Initial `selectionProbability=25/N` is marginal inclusion probability in the initial eligible pool. A replacements follow the frozen random permutation after excluding ineligible/reserved tracks; their recorded probability is conditional `1/N_remaining` for that draw. Skipping creates nonresponse, so the eventual answered subset need not be representative; retain skipped reservations when analyzing that limitation.
- **B — 25 diverse, training.** Round-robin save-age quartiles (7/6/6/6), prefer least-represented primary artists, then greedy farthest-point coverage. Distances use empirical rank scales over save age, energy, danceability, happiness, tempo, acousticness, instrumentalness, liveness, speechiness, loudness, duration and release age. Missing values are neutral at 0.5; fields observed in less than half the pool or constant fields are neutral for everyone. Missingness is not a distance dimension. The initial seed point has coverage score 1; subsequent scores are RMS distances to previously selected B points. This is a heuristic, not a probability or a claim of a learned improvement. It covers the unlabeled pool, without using prior label outcomes.
- **C — 20 uncertain, training.** One complete current C1 scoring response freezes the model version and all probabilities before selection. Select decreasing binary entropy, preferring unused primary artists, from the fixed **entropy ≥ 0.8 bits** ambiguity band (approximately probabilities 0.243–0.757). The threshold was specified before Batch 2 labels. Every current score is explicitly `entropy_heuristic`; no calibrated uncertainty claim is made. If fewer than 20 remain after A/B selection, return an explicit error without saving a partial batch. If artist diversity is scarce, least-represented artists may recur inside the ambiguity band. Replacements never leave that band.

A/B/C are interleaved for presentation. The database retains the frozen candidate tracks, feature vectors and rights provenance, prediction snapshots, full ordered reserve pools, seed, algorithm/model version and timestamp. Each immutable reservation records batch item ID, group, method, score, score kind, probability when known, assignment, position, selected time and replacement link. Stable item IDs survive fresh exposures after Undo; old exposure mappings remain available for retry/history. No rescoring or enrichment occurs on refresh, restart or replacement. Newly minted and renewed Batch 2 exposure IDs are not registered in C1's `/explain` cache; existing nonbatch `/explain` behavior is unchanged. Private audits use the immutable database feature/prediction snapshots. The calibration UI has no `/explain` caller and keeps predictions hidden; a future inspector flow needing this must coordinate a separate contract change.

## Isolation and lifecycle

Migration **015_calibration_batch2.sql** adds batches, immutable track reservations, exposure mappings and idempotent Skip commands. Existing label/Undo request and response DTOs are unchanged. The server resolves the batch item from the exposure. B/C labels explicitly use `train`; A labels retain ordinary storage compatibility but are **entirely excluded by `ml_training_examples`**, not passed as normal holdout rows. This excludes sealed outcomes from manual fit, automatic full-snapshot fit, and the ordinary evaluation metrics computed during fitting. The optional online observe adapter checks the sealed reservation too. Existing old train/holdout assignments are untouched.

Every reserved track is excluded from ordinary calibration/cleanup selection and new writes, including pre-existing exposures, Skip and Undo. Sealed reservations are permanent. All batch items remain reserved for the lifetime of this experiment, including training items; no release/reset endpoint is implemented. Calibration never creates cleanup work or C2 associations/rewards. C2 remains inactive. Future research exports must read the filtered ML view by default and must not query sealed label outcomes until a separately authorized frozen evaluation is ready.

Skip persists no label and atomically selects the next still-eligible candidate from the same frozen group. Previous reservations remain in place. If that pool is exhausted, the Skip still succeeds, the shortfall is explicit, and the batch is not regenerated. Undo revokes feedback, preserves assignment and renews only the exposure for the same frozen item. Renewal is strictly newer than the last feedback timestamp. A browser command journal recovers lost label/Skip/Undo responses using the original key. A failed session transition clears old cards and blocks actions until refresh succeeds. Browser storage reads occur inside recovery, so denied storage cannot crash App construction or overwrite an unread pending command; refresh restores the saved session and command once access returns. A first-attempt review rejection for a newly reserved Batch 2 track clears only that unaccepted command and refreshes the queue through GET; a failed refresh keeps review paused. Earlier ambiguous commands retain their original recovery journals until server history confirms the outcome.

## API and integration

New exports: `CalibrationBatchService` / `CalibrationBatchOptions` from API calibration; `PostgresCalibrationBatchStore` from `@sortfm/db`; shared Batch/Create/Skip/Read schemas and `CalibrationBatchStore` port. Routes retain the existing owner, CSRF, strict-body and no-store protections:

| Route | Purpose |
|---|---|
| `GET /api/calibration/batch2` | `{batch:null}` before creation; otherwise resume authoritative batch |
| `POST /api/calibration/batch2` with `{"seed":42}` | Create once, or resume |
| `POST /api/calibration/batch2/skip` | `{exposureId,idempotencyKey}`; same-group replacement |
| Existing calibration label / Undo routes | Reused unchanged |

Integration lead owns **runtime.ts, migration deployment, merge and production session creation**. This branch intentionally does not change runtime.ts. Supply the optional `batch` property to `createCalibrationModule` after migration 015 readiness:

```ts
batch: new CalibrationBatchService(new PostgresCalibrationBatchStore(database), {
  assemble: (rows, {userId, now}) => assembleLibraryCandidates(rows, {
    userId, now: new Date(now).toISOString(), metadataTraining,
  }),
  score: (userId, candidates, modelVersion) => ml.score(userId, candidates, modelVersion),
})
```

Missing optional batch wiring returns an explicit 503; legacy calibration and cleanup still work before migration 015. After integration, open **Teach your taste → Start / resume Batch 2**. The UI retains existing cards, keyboard/swipe controls and Undo, hides song predictions, and distinguishes saved training/evaluation labels from C1's actual counts.

Do not apply 015 as part of the independent 014 playback rollout. No production migration, merge or deployment was performed by this feature agent.

## Composition and limitations

The required initial composition is 25 random sealed evaluation items, 25 diverse training items, and 20 uncertain training items, all unique. The authenticated persisted batch response records the actual composition and provenance; production creation belongs to the integration lead after rollout. Real listener diagnostics, preview membership, model revisions and account-specific coverage are kept only in the private handoff report, outside this repository.

Entropy describes ambiguous model predictions, not calibrated uncertainty or predictive performance. Audio coverage may be incomplete; missing audio can be disproportionately common among uncertain predictions. Primary-artist diversity does not guarantee diversity across every collaborator. Random A can be age-imbalanced by chance. Skips create nonresponse bias. Sealed outcomes must remain untouched until the separate evaluation protocol is frozen.

## Verification

- Full default suite: **671 passed, 106 gated skips, 0 failures** on the final implementation. The three loopback socket tests need normal local network access; rerunning outside the sandbox passed.
- Disposable Tiger + temporary actual C1: **15 passed / 121 assertions** across batch persistence, legacy calibration, calibration migration and feedback sync. Manual C1 fit and automatic `FeedbackWorker.runOnce` both retained only the two training examples while sealed labels were saved; evaluation reported 2 labeled, 2 training, 0 holdout. Direct observe rejected a sealed track.
- Deterministic/order-independent selection, prediction-independent A, exact group counts, feature and age coverage, C ambiguity floor, schema invariants, owner/history conflicts, concurrent creation, restart, immutable assignment, lost Skip response, Undo/relabel, equal-timestamp renewal, denied-storage startup/recovery, and cross-tab reserved-review rejection/recovery tested.
- Production web bundle with controlled local fixture: start/resume 70, Skip replacement without label, Keep, saved sealed count, refresh/resume same track and no browser errors. This is UI proof, not live production proof.
- Root typecheck, web lint, production web/API build, and foundation HTTP smoke passed. The build retained the existing Zod PURE annotation warnings. Independent review found no remaining concrete blockers after the session-switch, ambiguity-floor, and equal-timestamp Undo fixes.

Reproduce the dedicated suite with `TEST_DATABASE_URL` set to the test server, then `bun test packages/db/test/calibration-batch.test.ts packages/db/test/calibration.test.ts packages/db/test/calibration-migration.test.ts packages/db/test/feedback-sync.test.ts`. Each test creates and removes only its own random test schema; the C1 integration test also creates and removes a temporary artifact directory. Run `bun test`, `bun run typecheck`, and `bun run build` for general checks.
