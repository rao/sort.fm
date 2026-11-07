# P0 calibration without Spotify mutation

Status: additive contract and implementation plan only. API, persistence and UI owners must implement and verify the gates below before claiming the calibration screen is safe. C1 remains the cleanup ranking policy; C2 activation and SoundNet availability are independent.

## Boundary and behavior

- Separate owner-only routes and browser methods: `calibrationQueue`, `calibrationLabel`, `calibrationUndo`, `calibrationHistory`. Their canonical schemas live in `packages/contracts/src/calibration.ts`; paths live in `PUBLIC_ROUTES`. The label/Undo methods synchronously commit a DB transaction and return 200 only after that commit. Training happens through the existing durable feedback outbox, or an explicit manual retrain.
- Buttons express preferences: “Would keep” (0), “Would remove” (1), and local Skip. Neither binary label changes Spotify. Undo removes this label from future fits; it does not change Spotify or restore a previous label. Do not reuse cleanup `ReviewStore.decide`, its gesture/keyboard handlers, or its durable command journal.
- Queue cards retain truthful predictions/features for audit, but the UI hides predictions while collecting labels. Sample broadly across save dates/artists without consulting the removal score. Partial/missing SoundNet data is valid. Use actual keyed ML predictions or the existing truthful unavailable baseline; never fabricate a fitted score. Calibration exposures use their own truthful deterministic policy version and `propensityEstimate=null`.
- `CalibrationLabelResult.submittedLabel` is the immutable human response. Only `state=active` has an effective binary `label`; revoked/superseded states have null label and cannot be undone. Same-key retry returns current state, not an obsolete active response. History must allow recovery by original key. A calibration result never reports liked/archive outcomes.

## Type-only A/D port

`CalibrationStore` is exported from `@sortfm/contracts` via `calibration-persistence.ts`:

```ts
calibrationCandidates(userId: string): Promise<CalibrationCandidateSnapshot>
insertCalibrationExposure(input: ExposureInput): Promise<void>
createCalibrationLabel(input: CalibrationLabelInput): Promise<CalibrationLabelResult>
undoCalibrationLabel(input: CalibrationUndoInput): Promise<CalibrationLabelResult>
calibrationHistory(userId: string): Promise<CalibrationHistory>
```

`CalibrationCandidateSnapshot` contains the full current library (`track`, `currentStatus`, nullable `audioFeatures`, nullable `currentDecision`) for feature context, plus distinct `eligibleTrackIds`. D excludes active labels from the eligible set; correcting one requires Undo and a fresh exposure. A independently samples those IDs and assembles features from the full library. These reads are advisory: new exposure publication and commands recheck current eligibility transactionally.

`CalibrationLabelInput` supplies server-derived `{userId,labelId,request,requestFingerprint,createdAt}`. `CalibrationUndoInput` supplies `{userId,commandId,labelId,request,requestFingerprint,createdAt}`. D validates those inputs and derives the authoritative revision/split/effective state; the browser supplies none of those authority fields. Fingerprints cover canonical request content (Undo includes its target labelId), excluding newly generated server attempt IDs/timestamps so replay stays idempotent. Every method is owner-scoped and atomic with detached return values. No transaction callback or port implementation performs network I/O.

## Persistence and precedence

1. Add separate calibration label/Undo records, unique owner/operation/idempotency keys, owner/exposure/track foreign keys and immutable label identity. Retain enough history for retries and projected active/revoked/superseded states. Do not insert fake Spotify decisions, review work, mutation journals or C2 bindings.
2. Store exposure purpose independently of the existing immutable payload; backfill/default existing records to `review`. `insertCalibrationExposure` sets `calibration`. New cleanup commands require review purpose; new calibration commands require calibration purpose. One calibration exposure is consumed only once, including after Undo; identical-key retries resolve before the consumption check.
3. New calibration labels require current imported ownership, playable real track, saved/deferred status, an unconsumed matching exposure, and no unresolved review/Undo (including expired leases). For this P0, reject a track whose current cleanup decision is still `COMPLETE`, including SKIP; never-reviewed, `UNDONE` and terminal-failed tracks may qualify. This prevents old cleanup Undo from erasing newer calibration. Recheck these predicates under the shared owner lock. Require a fresh exposure newer than the latest feedback/cleanup state change. Preserve originalAddedAt, saved status and membership.
4. Under that same lock, label/Undo changes the one owner feedback revision exactly once and schedules the existing feedback-sync outbox. New Undo requires the latest effective calibration label and no pending cleanup/Undo; a newer settled label/action yields `409 STALE_CALIBRATION_LABEL`. Repeated identical Undo returns its revoked result without another revision. Other conflicts use explicit 409 errors; invalid shapes use 400 and foreign/missing identities do not disclose another owner's records.
5. Unified effective feedback selects the latest settled revision per owner/track **including** null/revoked tombstones before filtering for usable labels. Pending replacement/failed mutation leaves the previous label effective. Completed cleanup supersedes calibration; cleanup Undo leaves a tombstone instead of reviving the calibration label. Superseded history is a projection of the winning feedback revision, not another owner revision or a second training example.
6. Update both `ml_training_examples` and `Repository.settleDecision`'s prior-feedback/split lookup. Otherwise `ReviewWorker` sees calibration in its training snapshot while settlement ignores it, producing revision conflicts. Preserve existing cleanup behavior and tests. First persisted split across both sources survives replacement, Undo and subsequent relabeling; new tracks use SHA-256 of `[42,userId,trackId]` modulo 5, bucket 0 holdout. Never choose splits using the labels or holdout performance.
7. Map real calibration label IDs to opaque `TrainingExample.decisionId` in the unchanged C1 DTO. Keep one example per track, exposure-time features, the same `trainingExamples()` owner lock and complete-snapshot `/fit`. Do not send `/observe` plus `/fit` for the same revision. C2 must never infer a cleanup exposure/reward solely from a calibration example ID.

## Ownership and merge order

| Owner | Deliverable |
|---|---|
| Root | This additive contract/port, generated artifacts, runtime registration and integration acceptance |
| D | Migration, CalibrationStore implementation, purpose checks, unified feedback/split projection and cleanup settlement reconciliation |
| A1 | Separate calibration routes/service, existing session/CSRF/no-store/error behavior, metadata-diverse queue and feedback-worker kick; no Spotify dependency |
| B2 | Separate calibration client/store, preference controls, isolated retry journal/history/Undo, hidden predictions and real label/model counts |
| C1 | Preserve frozen DTOs; verify calibration examples, missing audio and fixed holdouts; isolated offline prepare/freeze/evaluate workflow |

Land contracts first. A/B can use contract fixtures while D implements the additive migration; enable live routes only after persistence and cross-purpose rejection are integrated. B must keep calibration disabled or explicitly unavailable until those routes exist. Deployments must apply the migration before activating the new backend. Do not overlap another owner's active worktree.

Offline C1 calibration exports must contain no credentials and stay out of Git. Its evaluation uses an isolated artifact directory and frozen split/predictions. It must not publish its model into the serving artifact store or invent online revisions. Importing any collected offline human labels into serving state requires the same validated persistence/exposure path, with a separate reviewed import step; this contract does not authorize bypassing it.

## Required verification

- Binary labels, Skip, retry, response loss/reload and calibration Undo cause **zero Spotify transport calls** and no review work, mutation journal, membership or saved-status changes. Wrong-purpose exposures fail in both directions before command creation.
- Both classes reach the durable training snapshot with exact exposure features. Concurrent/repeated requests preserve one owner revision, one effective example per track and one immutable split. Owner mismatch, changed-key payload, consumed/stale exposure and pending review/Undo fail safely.
- Calibration → pending cleanup preserves calibration; confirmed cleanup supersedes it; cleanup Undo leaves no resurrected example. Calibration Undo after newer cleanup fails stale. Undo/relabel cannot move a holdout. Existing KEEP/ARCHIVE/UNLIKE/SKIP/Undo tests remain green.
- Real C1 automatic feedback and manual retrain fit the identical DB snapshot/revision. Subsequent queue reads use the published C1 model; old keyed explanations remain unchanged. Insufficient data stays explicit: current engineering thresholds are 12 train labels with at least 3 per class for a learned classifier, and at least 20 holdout labels with both classes for evaluation.
- No automatic label generation from historical Likes, no forced class balance, no fabricated metrics, and no C2 reward/activation. Full typecheck, contract/export checks, affected DB/API/web tests, and disposable-Tiger/real-C1 integration smoke pass before release.
