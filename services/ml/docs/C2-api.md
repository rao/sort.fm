# Historical C2 v1/v2 API and integration gates

This records the original online-observation client and lease implementation.
For current v3 snapshot integration, revision pinning, common eligibility,
association-only feedback, and storage migration, use [C2-association-api.md](C2-association-api.md).
In particular, the historical C1 filtering bypass and pending adapter proposal
below are superseded; current integrated clients use `/fit` + `/policy/associate`.

Implemented and tested inside `services/ml`; public API/TypeScript/Tiger Data adoption belongs to the integration lead. No shared contracts or other owners' modules were changed. Contract `1.0.0`, feature version `sortfm.features.v1` and C1 model/engine formats remain unchanged. Exact local schemas are in `src/sortfm_ml/policy_schemas.py` and the service's OpenAPI document.

**Production activation remains disabled.** The approved lease/release implementation is service-local. The existing A2 `FeedbackWorker` sends `/fit` snapshots, not `/policy/feedback` events; those snapshots cannot establish committed C2 reward or review history. A coherent feedback adapter, backend eligibility checks and public wiring remain integration gates described below.

All five routes require `Authorization: Bearer <ML_SERVICE_SHARED_SECRET>`. The backend derives and authorizes `userId`; this key does not authenticate individual listeners. Never expose these routes directly to the browser. Existing error envelopes and 401/422/409/503 semantics apply.

| Method | Route | Result |
|---|---|---|
| POST | `/policy/select` | One reserved selection and immutable prediction/policy diagnostics |
| POST | `/policy/feedback` | C1 ObserveRequest plus optional usefulness rating; unchanged ObserveResponse |
| POST | `/policy/release` | Immutable receipt closing one exposure's scheduling lease |
| GET | `/policy/diagnostics?userId=...` | Actual counts, active reward summary and latest decision |
| GET | `/policy/exposure?userId=...&exposureId=...` | Original decision, feedback flags, current reservation and frozen eligibility snapshot |

Existing C1 request/response DTOs are unchanged. `/observe` records C2 feedback when its exposure belongs to the policy; other observations continue through C1. Direct Python consumers must use `PolicyService.observe` for policy exposures: bypassing the HTTP adapter with `ModelService.observe` cannot capture the exposure-to-feedback association.

## Selecting

```json
{
  "userId": "demo:listener",
  "featureVersion": "sortfm.features.v1",
  "exposureId": "11111111-1111-4111-8111-111111111111",
  "modelVersion": null,
  "seed": 42,
  "config": {"strategy": "linucb", "alpha": 0.5},
  "candidates": [{
    "trackId": "demo:track-a", "artistIds": ["demo:artist-a"],
    "features": {"featureVersion": "sortfm.features.v1", "values": {"energy": 0.6},
                 "provenance": "synthetic", "permittedForTraining": true}
  }]
}
```

Supply 1–10,000 unique candidates with ordinary shared FeatureVectors. Local optional `artistIds` accepts at most 20 identifiers; artist identities cannot be inferred from artist-library counts. The backend supplies current reviewable membership and truthful provenance. Candidate ordering is canonicalized by track ID. Identical exposure/input retries return the original decision after retraining/Undo/restart and after expiry/release; they never renew or reacquire a lease. Changing the candidate set, config, seed or model request under an existing ID returns 409. Use a new UUID for new scheduling and retain the original on retry. Before serving an expired or released replay, the backend must inspect its lifecycle and recheck database eligibility; an immutable historical response is not permission to show or mutate the track again.

| Config | Default | Meaning |
|---|---:|---|
| strategy | linucb | linucb, epsilon_greedy, random, or c1 |
| alpha | 0.5 | Uncertainty coefficient, range 0–10 |
| ridge | 1 | Positive ridge penalty, range 0.001–1000 |
| epsilon | 0.1 | Epsilon-greedy random-draw probability, range 0–1 |
| maxExplorationFraction | 0.25 | Prefix cap on departures from the reward-greedy choice |
| diversityWindow | 5 | Prior selections counted for artist constraints, range 0–100 |
| maxPerArtist | 2 | Artist occurrences allowed in that preceding window, range 1–100 |
| obviousKeepThreshold | 0.1 | Protect lower C1 probabilities from exploratory departures |

Exploration is allowed only while prior departures are below `floor(fraction*(step+1))`; reservations count even before feedback. Artist constraints apply to cold and learned adaptive selection. Infeasible constraints relax with a recorded reason. Unknown/partial artist metadata is reported and cannot guarantee diversity. If every candidate looks like an obvious keep, that fact is reported rather than inventing a better option. Reward-greedy candidates remain eligible even at low removal probability because useful KEEP reviews matter.

`strategy=c1` disables C2 constraints and returns `rankedTrackIds` exactly in C1 rank order for the supplied pool, plus the first prediction. Other strategies select one track at a time and return `rankedTrackIds=null`. Zero policy rewards trigger explicit C1 fallback, even if C1 already has supervised labels. Missing audio uses C1's finite missing-aware contexts; no track needs an individually trained arm.

Adaptive selection excludes a track while any lease for it is live. Independently, committed C2 strong-review history plus an authoritative current C1 example suppresses completed reviews, including holdout examples. Preexisting C1 fit examples without such C2 history are not globally excluded. Committed Undo closes only its exposure's active lease when no current example remains; stale/no-op Undo cannot clear a newer review or lease. Full-fit removal clears completed-review suppression but does not cancel a still-live lease. SKIP remains unrewarded and can be explicitly released or allowed to expire. A reservation is not proof of viewing. Explicit `strategy=c1` bypasses filtering but still creates a lease that can affect later adaptive selection.

## Lease configuration and release

Every new exposure freezes server UTC `reservedAt` and `expiresAt`. The default TTL is **300 seconds**; `ML_POLICY_RESERVATION_TTL_SECONDS` accepts an integer from **30 through 900**, captured at application startup. Configuration changes affect new leases only. At `now >= expiresAt`, the lease is closed at its original deadline. Selection, exposure inspection and release reconcile lifecycle under the per-user lock; terminal closures are persisted so observed expiry cannot be reversed by clock rollback. Clock synchronization is still required for wall-clock TTL accuracy.

Tests can inject `PolicyService(models, clock=callable, reservation_ttl_seconds=300)` or `create_app(..., policy_clock=callable, policy_reservation_ttl_seconds=300)`. The callable returns an aware `datetime`; omitted clocks use server UTC. TTL and clock are service configuration, never client request fields.

```json
{
  "userId": "demo:listener",
  "requestId": "22222222-2222-4222-8222-222222222222",
  "exposureId": "11111111-1111-4111-8111-111111111111",
  "reason": "prefetch_discarded"
}
```

`POST /policy/release` strictly accepts `userId`, UUID `requestId`, UUID `exposureId` and reason `skip`, `abandoned` or `prefetch_discarded`. Extra fields are rejected. It returns `userId`, `requestId`, `exposureId`, `trackId`, `outcome` (`released` or `already_closed`), server `recordedAt`, the original `expiresAt`, and `effectiveClosedAt`. Closure and its receipt commit atomically in the policy ledger. For expiry, the effective closure time is the original deadline, not the later inspection/release time.

Idempotency is scoped to the user, release operation and request ID. Identical retries return the exact saved receipt; changing the exposure or reason returns 409. Unknown and foreign-user exposures return 404. A fresh request against an already closed lease returns `already_closed` and the original closure time. Releasing an old exposure cannot close another lease for the same song. A receipt reports that exposure's history, not current track eligibility.

Release and expiry never cancel provider operations, delete feedback/predictions/rewards, revoke labels, extend a deadline or reset selection history. Delayed feedback remains subject to the original C1 event/revision rules. Backend retry/outbox delivery should release skipped or discarded items; if delivery is lost, TTL still bounds the lease. There is no skip cooldown: the backend should omit a skipped track from the current session pool if immediate resurfacing is undesirable.

## Inspector and log fields

The decision retains selected features, original C1 prediction, model/feature/context/reward/policy versions, `policyStateVersion`, seed/step/config, and creation time. It logs every supplied candidate ID and a canonical SHA-256 of full candidate feature/artist inputs. Save the original request for feature-level reconstruction: hashes cannot reconstruct vectors. `candidateCount` is the input pool; adaptive `availableCount` excludes live reservations and completed reviews; `selection.eligibleCount` reflects final constraints.

`/policy/exposure` adds two siblings to the unchanged immutable `decision`:

- `reservation`: `exposureId`, frozen `reservedAt`/`expiresAt`, current server `evaluatedAt`, `status` (`active`, `released`, `expired`), nullable `closedAt`, and nullable `closureReason` (`explicit_release`, `undo`, `expiry`). This describes this exposure, not backend eligibility.
- `eligibility`: the frozen selection-time `evaluatedAt`, `filteringApplied` and canonical `exclusions`. Each exclusion has `trackId`, sorted `blockingExposureIds` and `completedReview`. This snapshot contributes to `policyStateVersion`. It remains historical when leases later close; migrated v1 selections return `eligibility=null` because their original eligibility snapshot was not recorded.

Exact replay across fresh runs requires the same seed, clock, candidate inputs, C1 model and lifecycle history. Release/expiry does not remove old selections from the exploration quota or diversity window. C1 mode records the same eligibility facts with `filteringApplied=false`.

| Selection field | Interpretation |
|---|---|
| predictedReward | Unbounded linear mean estimate of review utility, never removal probability |
| baselineScore | C1 probability or explicitly identified heuristic from nested Prediction |
| uncertainty | `sqrt(xᵀ A⁻¹ x)`, uncalibrated design radius; may exceed one |
| explorationBonus | alpha × radius for learned LinUCB; zero for other strategies/fallback |
| selectionScore | LinUCB UCB, epsilon-greedy mean, random probability, or C1 fallback score |
| informationGain | `0.5 log(1+xᵀ A⁻¹ x)`, hypothetical design information with unit noise |
| strategy | explore iff selected track differs from feasible reward-greedy track |
| greedyTrackId, reasons, context | Explain comparator, constraints and exact original coordinates |

Deterministic LinUCB/C1 propensities are null. Epsilon-greedy uses `epsilon/N + (1-epsilon)` for greedy and `epsilon/N` otherwise; random uses `1/N`, after constraints. These are nominal probabilities over the declared pseudorandom draw conditional on pool/config/history, **not conditional on a publicly fixed seed**. Seeded replay alone is not an unbiased logging experiment. Excluded actions have no support. Do not infer IPS/DR/off-policy uplift from these logs without a valid experimental design.

Use `/evaluation` for supervised accuracy and `/policy/diagnostics` for policy counts/rewards. Diagnostics separate pending/committed events, skips, holdout exclusions, active training rewards, explicit ratings and KEEP/REMOVE labels. Exposure feedback includes original reward plus current `committed`, `active`, `eligibleForLearning` and split flags. Never sum revoked/pending rewards into current totals. No “RL accuracy” is emitted.

## Feedback and rewards

Send only completed user reviews after backend mutation success. `/policy/feedback` adds optional `usefulness` in [0,1] to the existing ObserveRequest. Without ratings, ordinary `/observe` suffices. SKIP is upsert with null label; Undo is revoke with null label. Neither accepts a rating or earns a training reward. Event IDs and ratings are immutable on retry. An authoritative permanent rejection removes the uncommitted intent so corrected input can reuse that rejected C1 event ID.

Reward `review-utility-v1` is `0.75*usefulness + 0.25*(label-frozenRemovalProbability)^2`. Without an explicit rating, usefulness=1 is honestly labeled a **completed-review proxy**, not listener satisfaction. For heuristic predictions, correction=0 because no probability exists. There is no deletion bonus. A surprising KEEP can be valuable. Squared prediction error is a correction/surprise proxy, not measured information gain, and can increase when predictions worsen. Read reward alongside usefulness and heldout quality. Design-information gain is logged separately, not added again.

Only exact committed C1 events with currently active matching track/decision/label/features contribute, and only on the fixed `train` split. Holdout feedback is logged but never trains policy. Undo, supersession and full-fit removal eliminate active contributions. C1's ledger is authoritative; old C1 labels without policy exposures never become fabricated bandit rewards.

## Mathematics and persistence

Contexts are `[bias, C1 probability-or-heuristic, C1 transformed columns] / max(1,L2 norm)`. At selection time, all eligible historical examples are transformed under the same pinned C1 model as the candidates. Rebuild `A=ridge I+XᵀX`, `b=Xᵀr`, `theta=A⁻¹b`; choose using `xᵀtheta + alpha*sqrt(xᵀA⁻¹x)` inside the constraint set. The implementation uses Cholesky solves. This preserves consistent coordinates after C1 refits and exact removal of revoked reward observations while keeping exposure contexts/rewards immutable. Adaptive representations and constraints do **not** support a stationary-environment regret guarantee. References: [LinUCB](https://arxiv.org/abs/1003.0146), [offline replay assumptions](https://arxiv.org/abs/1003.5956).

Each user's hashed artifact directory holds checksummed `policy.json` selections, feedback intents, reservations and release receipts. Storage format `schemaVersion=2` is independently versioned; new selections use `c2-linucb-v2`. Context and reward versions are unchanged. POSIX locks serialize local processes. Selection is durably reserved before C1 exposure registration; identical retries repair interrupted registration using the decision's original policy version. Feedback intents precede C1 publication and become effective only when their exact fingerprint appears in C1's committed ledger. Retry interrupted/transient requests with identical IDs; uncommitted intents earn nothing and cannot extend leases. Existing keyed `/score` and `/explain` reuse policy predictions.

The reader migrates verified `c2-linucb-v1` ledgers under the user lock. Every legacy deadline is derived from its original `createdAt` plus a fixed **300 seconds**, irrespective of current TTL configuration; startup never restarts old leases. Migration reconciles current C1 committed Undo and expiry before serving. Original decisions, fingerprints, feedback, prediction snapshots and version tags are preserved. Invalid timestamps/checksums or unsupported storage fail with 503 instead of resetting state. Make a complete verified backup before migration; no automatic pre-migration backup is created. Downgrading to the old reader requires restoring that backup.

Use one service replica and durable trusted POSIX storage. Separate hosts require coordinated persistence. No retention, compaction, cross-host transaction protocol or automatic corrupt-state reset is implemented. Restore complete verified backups of C1 and policy artifacts. See the handoff for measured verification; catastrophic process-kill recovery and deployment SLAs remain unverified.

## Integration-owned contract decisions

1. Publish these local schemas/routes through the integration lead before adding browser inspector/API wiring. Suggested knob mapping: certainty alpha0, balanced0.5, discovery1; backend/product owns adoption and caps.
2. Shared `Exposure.uncertainty` **must remain C1 prediction uncertainty** to satisfy `predictionMatchesExposure`. Store C2 radius/UCB/design gain separately.
3. Existing public `selectionMethod` accepts linucb and C1 baseline/rank names but **not epsilon_greedy/random**. Keep these local/simulation-only until an explicit contract amendment; never mislabel them. Cold c1 maps to deterministic_baseline for heuristics or logistic_rank for fitted C1. Public policy remains balanced/discovery/certainty.
4. Backend/D owns served/viewed times, user-scoped Tiger Data exposure/feedback telemetry and candidate-request retention. No migration or public UI was edited.
5. **Keep production C2 activation disabled.** A2's current `FeedbackWorker` transports `/fit` snapshots and never `/policy/feedback` events. C2 cannot infer committed reward/history from this transport. Root/A/C2 must design one coherent adapter; do not bolt `/observe` beside `/fit` at the same revision.
6. Backend candidate generation must exclude pending reviews/Undo **and settled reviews awaiting ML synchronization**. Revalidate database membership before serving or mutating; expiry does not establish eligibility or fence an in-flight mutation. An expired/released select retry must undergo lifecycle inspection plus database eligibility checking before serving. These backend changes are outside this implementation.
7. No shared identifier-pattern amendment was made by C2; the separately coordinated period-in-user-ID fix remains with foundation/C1.
