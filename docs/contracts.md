# Shared contracts 1.0.0

The source of truth is `packages/contracts/src/{schemas,features,db,calibration,routes}.ts`. TypeScript types are inferred from Zod. `bun run contracts:export` writes `packages/contracts/generated/contracts.schema.json` for Python and other consumers. JSON Schema cannot express every Zod cross-field refinement: the invariants here remain normative. Change field names through the integration lead and regenerate artifacts together.

The same command writes `packages/contracts/generated/demo-bootstrap.json`, a deterministic cross-language fixture matching the live bootstrap response shape. Timestamps/IDs in that artifact are fixed examples; HTTP routes generate fresh served timestamps/exposure IDs.

Wire JSON uses camelCase; dates are UTC ISO 8601 strings (offset input is accepted). UUIDs identify decisions, commands, exposures and events. Internal IDs allow letters, digits, colon, underscore, hyphen and period; dotted legacy Spotify usernames, illustrated by the authored placeholder `example.listener`, must round-trip unchanged as `spotify:example.listener`. Slash, backslash, spaces and URL query delimiters remain invalid. This additive prelaunch correction preserves contract/feature versions and is mirrored in Python. `trackId` is the 22-character Spotify ID or an explicit `demo:` ID. Synthetic track `spotifyUri` is always null. A Spotify card's URI must match its ID. No Spotify popularity or removed relinking fields are required.

## Review semantics

| Action | Key | Removal label | Mutation |
|---|---|---|---|
| KEEP | → | 0 | No Spotify write; reviewed |
| ARCHIVE | ← | 1 | Confirm private archive insertion before unlike; confirm unlike |
| SKIP | ↑ | null | Deferred; no supervised example or bandit reward |
| UNLIKE | ↓ | 1 | Direct unlike; visibly destructive; restore available |
| UNDO command | Undo button | revoke | Target an existing decision; restore like for ARCHIVE/UNLIKE |

`ReviewRequest` is exactly `{trackId, action, exposureId, idempotencyKey}`. `UndoRequest` is exactly `{idempotencyKey}` at `POST /api/decisions/:id/undo`. The client creates keys with `createIdempotencyKey()`. Preserve the same key on retry/reload, generate a new one for a new command. The server derives user identity from its session; request bodies reject `userId` and other extra fields.

Command uniqueness is `(userId, operation, idempotencyKey)`. Persist the command and request fingerprint **before** side effects. Same key and payload resume/return the existing command; changed payload is `409 IDEMPOTENCY_CONFLICT`. Each transition has a separate event ID; append-only events reference commands, so multiple events must not compete for the command's unique key.

DB `DecisionInput` persists the review command. `UndoCommandInput` separately persists `{userId, commandId, decisionId, request:UndoRequest, requestFingerprint, createdAt}`; `decisionId` remains the original target and `commandId` identifies this undo attempt. `ReviewResult.idempotencyKey` always identifies the original review; undo command deduplication uses its own stored request key.

Keep immutable decisions keyed by `decisionId`; a separate `(userId,trackId)` record points to the current decision. Undo targets that decision and must reject a stale decision if a newer review supersedes it (`409 STALE_DECISION`). While mutation status is pending/reconciling, `canUndo=false`; a workflow must settle/reconcile before undo (`409 MUTATION_PENDING`). Failed partial workflows need explicit recovery, not a fabricated completion. A persisted but unfinished Undo returns retryable `409 UNDO_PENDING`; the original completed decision and active label remain until restoration is confirmed. Retry the same Undo key and only treat `UNDONE` as success.

`ReviewResult` separates workflow status (`PENDING`, `COMPLETE`, `FAILED_RETRYABLE`, `FAILED_TERMINAL`, `UNDONE`) from `mutationStep` (`NONE`, `PENDING`, `ARCHIVED_PLAYLIST_INSERTED`, `UNLIKED`, `RESTORED`, `RECONCILING`). `liked` and `archived` are nullable confirmed states, never guesses. Completed ARCHIVE requires `archived=true, liked=false`; completed UNLIKE requires `liked=false`. Only completed strong decisions activate their label. SKIP stays unlabeled; Undo revokes the original label and increments `feedbackRevision`. A retry must not create duplicate labels. A stores durable state; foundation stubs have no persistence.

P0 archive undo restores the saved track and retains the archive playlist copy. Optional playlist cleanup belongs to later work. Original `added_at` remains stored as `originalAddedAt`; restoring the like cannot promise its original Spotify ordering/timestamp.

## Calibration-only human labels

The additive calibration contract does not imply the routes are implemented. Until A/D/B wiring passes integration checks, the existing `#/calibrate` review screen is **not** a non-mutating labeling flow. See [calibration integration plan](integration/calibration.md) for rollout and acceptance gates.

Calibration uses its own owner-only namespace: `GET /api/calibration/queue?limit=20`, `POST /api/calibration/labels`, `POST /api/calibration/labels/:id/undo`, and `GET /api/calibration/history`. POSTs require the same exact-origin/CSRF and session checks as cleanup. They commit local labels only: no Spotify transport, review command, mutation worker, saved-status or membership change. Request bodies and queries are strict; empty queries are required except the queue's limit (1–100). Queue/history responses use `Cache-Control: no-store`.

`CalibrationLabelRequest` is exactly `{trackId, exposureId, label:0|1, idempotencyKey}` for a real 22-character Spotify track ID. Label 0 means “I would keep this”; label 1 means “I would remove this”; neither performs that action. The server supplies owner, label ID, revision, timestamps, split and exposure-time features. Undo reuses `UndoRequest` exactly and targets the original `labelId`. Skip is client-local, submits nothing and never revokes a label; skipped cards may reappear after a refresh. Calibration must not reuse cleanup buttons, shortcuts or its pending-command journal.

`CalibrationQueueResult` has `mode=calibration` and otherwise reuses the existing card/prediction/exposure structure. Cards must be real, unique owned candidates; `remaining` includes the returned items. Persist each exposure with server-only purpose `calibration`; existing exposures/inserts default to `review`. Purpose is outside the unchanged `ExposureInput` payload and is never trusted from the browser. Both command paths must reject the other purpose before writing work. Preserve immutable features and keyed predictions, but hide prediction scores/explanations in the labeling UI. Sampling uses metadata diversity independently of predicted removal rank; deterministic sampling has no fabricated propensity or C2 policy attribution.

`CalibrationLabelResult` has `mode=calibration`, `labelId`, `trackId`, `exposureId`, original label-command `idempotencyKey`, immutable `submittedLabel`, effective `label`, `state`, `canUndo`, `feedbackRevision`, `createdAt`, and `updatedAt`. It has no Spotify outcomes or mutation status. `active` means this is the current settled feedback for the track; its label equals `submittedLabel`. `revoked` means this label was explicitly undone. `superseded` means newer settled feedback displaced it before Undo. Revoked/superseded results have `label=null, canUndo=false`; preserve the originally submitted label for honest history/retry comparison. Pending cleanup/Undo may temporarily make an active label non-undoable without removing it. A previously revoked row stays revoked after later feedback. `feedbackRevision`/`updatedAt` identify the owner revision/time at which the represented effective state arose, including the displacing event for a superseded row; they are not a claim that ML already trained it.

Same `(owner, calibration-label|calibration-undo, idempotencyKey)` and canonical payload returns the same label identity with current authoritative state before eligibility checks; another payload returns `409 IDEMPOTENCY_CONFLICT`. Undo keys are independent of original label keys. History returns these same projected states, newest-created first, allowing response-loss recovery without inventing another command. Clients preserve the original key across retries/reloads and do not automatically replay an ambiguous write under a new key.

Under the shared owner lock, D commits label/revocation, the one `users.feedback_revision`, and the existing `feedback_sync_jobs` outbox together. The unified effective-feedback projection includes both calibration and cleanup, retaining null/revoked tombstones so Undo never revives an older label. Pending cleanup does not supersede feedback; confirmed settlement does. `ml_training_examples` and cleanup settlement's prior-feedback/split lookup must use this same projection. An active calibration's genuine UUID is mapped to the frozen ML field `TrainingExample.decisionId`; no fake `review_decisions` row is created. Split identity comes from the earliest ever persisted split across both sources, including revoked rows; new tracks use the existing SHA-256 rule with fixed seed 42. Existing ML DTOs, feature version and `/fit` behavior are unchanged. Both automatic feedback and manual retraining fit this complete authoritative snapshot. No calibration feedback creates C2 associations or rewards.

## Queue, model and session boundaries

`QueueResult = {contractVersion, mode, items, remaining, nextCursor, fallbackReason}`. Each item contains `{track, prediction, exposure}`. `TrackCard`, `Prediction` and `Exposure` are independently exported. Queue exposure records preserve the score/version/context at serving time. Validate exposure owner and track at review time. Each new decision consumes a fresh, unconsumed exposure newer than the current decision update; after Undo, fetch a new queue exposure before a new decision. Deduplicated retries return the original command before freshness or membership checks, including after removal. A served/prefetched item is not necessarily a viewed item. Demo fixture exposures are regenerated per request and are not durably recorded in Task 00.

DB `ExposureInput` stores both the full `prediction` (including explanations and uncertainty method) and named `features` alongside `exposure`; all versions/scores must match. `/explain` must use this persisted snapshot rather than the current model.

`Prediction.removalProbability` is nullable; heuristics use `heuristicScore` and cannot label it a probability. `uncertainty` is nullable, with `uncertaintyMethod` (none/entropy/bootstrap); no fabricated confidence bands. Ranking/policy fields live on the exposure, separate from classification. `propensityEstimate=null` for a deterministic policy without a defensible probability. `selectionMethod=fixture` is not learned ranking. Model version starts `untrained-v0`, with zero trained examples.

`ModelMetrics` includes actual label/train/holdout counts, model/dataset/evaluation method, timestamp, base rate, balanced accuracy, ROC-AUC, PR-AUC, log loss, Brier score and precision@k. Unavailable metrics are null. `status=available` requires >=20 held-out examples and both classes. No training labels enter holdout or its taste-centroid computation. Fixed holdout identity is preserved across retrains; changing the split is a new evaluated experiment. Imported historical likes are candidates, not KEEP labels.

`AccountSession` contains only mode, public user profile and capabilities. Anonymous/demo sessions cannot advertise Spotify capabilities. No OAuth access/refresh token, secret, provider key or encrypted credential belongs in this DTO. Demo has `spotifyId=null`. Real playback integration must reconcile browser SDK token requirements with the master spec's server-only token requirement before adding an SDK endpoint; open-in-Spotify is the P0 fallback.

## Public HTTP contract

The complete schema-bearing registry is `PUBLIC_ROUTES` in `routes.ts`. All errors use `{code, message, retryable?}` with the corresponding non-2xx status. Unknown/malformed requests never return stack traces or raw provider errors.

| Method | Path | Foundation behavior / future owner |
|---|---|---|
| GET | `/api/health` | 200, actual capabilities; liveness is not DB/ML readiness |
| GET | `/api/auth/spotify/start`, `/api/auth/spotify/callback` | 501; A1 |
| POST | `/api/auth/logout` | 501; A1 |
| GET | `/api/me` | Anonymous session; A1 adds session lookup |
| POST | `/api/library/sync` | 501; A1 |
| GET | `/api/library/sync/status`, `/api/library/summary` | 501; A1/D |
| GET | `/api/queue?limit=20&policy=balanced&mode=demo` | Synthetic queue; default mode=spotify requires auth and returns 401 |
| POST | `/api/decisions`, `/api/decisions/:id/undo` | Validate body then 501; A2 |
| GET | `/api/decisions/history` | 501; A2 |
| GET | `/api/analytics/summary`, `/api/ml/insights` | 501; A/C/D integration |
| POST | `/api/ml/retrain` | 501; owner only when implemented |
| GET | `/api/player/status` | 501; A/B2 |
| POST | `/api/player/play` | 501; A/B2, `{trackUri}` |
| GET | `/api/demo/bootstrap` | Synthetic session+queue+metrics+notice; no cookie created |

Allowed `policy` values are `balanced|discovery|certainty`; limit 1–100. Demo endpoints return 404 when disabled. `GET /api/demo/bootstrap` creates no durable session; B1 can use fixtures or client-local simulation, explicitly labeled. A2 must add isolated server demo sessions before accepting demo decisions.

Fastify uses exact configured CORS origins, credential support and `Cache-Control: no-store`; unexpected browser origins are rejected. A1 adds secure HttpOnly SameSite session cookies, randomized state, owner allowlist and CSRF/session enforcement. The API factory accepts `registerRoutes(app)` to replace unimplemented route placeholders; A owns later updates to implemented `/me` and `/queue` wiring.

## ML and features

### Optional policy selection telemetry

`Exposure.policyTelemetry` is an optional, strict `PolicyTelemetry` object; legacy exposures omit it. `Exposure.selectionMethod` additionally accepts `epsilon_greedy`. Existing C1 prediction, probability, uncertainty, model version and feature version keep their meanings. The UI `QueuePolicy` preference does not activate a server algorithm.

Telemetry carries actual `selectionMethod` (`c1`, `epsilon_greedy`, `linucb`, or service-local `random`), `strategy` (`explore`/`exploit`), `policyStateVersion`, `contextVersion`, `rewardVersion`, `modelFeedbackRevision`, signed finite `predictedReward` and `selectionScore`, nonnegative finite `uncertainty`, `explorationBonus` and `informationGain`, `candidateCount`, `availableCount`, `eligibleCount`, `trainedRewards`, and `reasons`. Counts satisfy eligible ≤ available ≤ candidate. C2 uncertainty is an uncalibrated design radius and can exceed one; reward and selection score are not removal probabilities. Policy version and the immutable C1 model version remain on the containing exposure.

The required nested `reservation` is a reported lifecycle snapshot with `reservedAt`, `expiresAt`, `evaluatedAt`, `status` (`active`/`released`/`expired`), nullable `closedAt`, and nullable `closureReason` (`explicit_release`/`undo`/`skip`/`expiry`). Its original duration is30–900 seconds. Active means open at the supplied evaluation time; released means a recorded terminal closure, and expired means closed at the original expiry time. Server wall-clock rollback can place an observation before issuance/closure, or a persisted release before issuance. Preserve those original timestamps without reopening or renewing a terminal reservation; released closure must not exceed the original expiry, and expired closure equals it. This snapshot is not proof that the user viewed/listened to the song and is not a current database eligibility assertion. The inspector must not derive a new lifecycle status from the browser clock. Absent telemetry means unavailable; zero values are valid observations.

### C2 private transport

Listening provenance is independently optional and server-only: `ExposureInput.listeningContext`, `CalibrationFrozenCandidate.listeningContext`, and `AdaptiveSelectionDraft.listeningContext` preserve a `ListeningContextSnapshot` beside frozen model inputs. It records the incomplete recent-play cache source, original fetch time, exposure `asOf`, cache age, 30-day event filter boundary and raw/distinct/in-window sample counts. It never claims complete 30-day coverage. Fresh empty samples have known zero sample counts but no per-track zero-play inference. Missing, invalid, failed or foreign-owner samples have explicit statuses; quarantined samples disclose no foreign metadata. Existing exposures, labels and saved batches retain their original payloads. `FeatureVector`, supervised algorithms and model inputs gain no metadata fields. The optional `A1Transaction.getTasteContext` reads only the existing owner-scoped cache; no provider I/O belongs in assembly.

`policy.ts` adopts the existing service-local select, release, exposure and diagnostics operations as shared, server-only schemas. Integration selections require an explicit non-null `modelVersion` and `feedbackRevision`, even though the selection wire schema permits legacy omission. The selected decision must report the actual matching revision. These routes require the ML shared secret and are never browser endpoints.

New `POST /policy/associate` accepts `{userId,event,fitReceipt}`. The immutable event includes a UUID `eventId`, positive per-owner `sequence`, literal `source=cleanup`, decision/exposure/track identities, original policy/model versions, `operation=upsert|revoke`, committed `feedbackRevision`, nullable binary label, frozen features, and `occurredAt`. Optional `usefulness` is allowed only for a labeled upsert. The separate fit receipt contains `modelVersion` and `synchronizedFeedbackRevision`; it must cover the event revision and match the actual currently published C1 fit. There is no caller-supplied split.

Association never invokes C1 fit/observe. The database emits these events only for committed cleanup decisions on actual policy-bound review exposures. Calibration and ordinary unbound C1 exposures cannot earn retrospective policy rewards. Fingerprint owner plus immutable event, excluding the fit receipt so retries can use a newer valid receipt. Changed immutable content is a conflict. Older/coalesced events remain history but earn reward only if the latest event is a strong upsert matching the current permitted C1 train example exactly. Undo and Skip have null labels and close only their original exposure. Holdout examples do not train the policy.

The receipt returns owner/event/sequence, immutable `recordedAt`, `duplicate`, the validated fit receipt and current-snapshot `eligibleForLearning`. Replays can report a different current eligibility after a later fit; that does not change the original event. C1 training acknowledgement and policy delivery remain independent. A policy outage must not prevent C1 from learning saved feedback.

Internal `GET /health` is public liveness. `POST /fit`, `/score`, `/observe`, `GET /evaluation`, `/explain` require `Authorization: Bearer <ML_SERVICE_SHARED_SECRET>`. Foundation returns 503 if unconfigured, 401 if invalid, and 501 if authenticated; it does not validate future model payloads or return fake scores.

| Route | Input | Output |
|---|---|---|
| `/fit` | `FitRequest`: userId, featureVersion, feedbackRevision, examples, evaluationSeed | FitResponse + measured metrics |
| `/score` | `ScoreRequest`: userId, featureVersion, candidates, nullable modelVersion | Track-keyed predictions + versions |
| `/observe` | `ObserveRequest`: eventId/decisionId/exposureId/trackId/userId, revision, upsert/revoke, nullable label, features, occurredAt | accepted, revision, nullable version |
| `/evaluation` | userId, optional modelVersion query | ModelMetrics |
| `/explain` | userId, exposureId query | Immutable exposure prediction |

Additive prelaunch amendment (November 7): each `/score` candidate may include an optional UUID `exposureId` (`ScoringCandidate`). When supplied, C1 stores the returned prediction snapshot under `(userId,exposureId)` for `/explain`; an identical retry returns the original snapshot, while reuse with conflicting track/features or an explicit different model version returns `409 EXPOSURE_CONFLICT`. A null modelVersion resolves once when the exposure is first scored. Unkeyed batch scoring remains valid and need not persist snapshots. The API assigns IDs before scoring and persists the same IDs/predictions in its exposure store. C1 must validate and persist keyed requests atomically so a partial batch failure cannot overwrite snapshots. This closes the earlier `/explain` registration gap without adding a route or changing training examples or existing required fields. Wire contract version remains `1.0.0` during this coordinated prelaunch addition; feature version is unchanged. Feature agents should take this shared commit before freezing their HTTP implementations.

Training examples explicitly carry `split:train|holdout`; C must train/preprocess on train-only examples. Revoke uses null label and targets the original decision. Deduplicate event IDs, reject stale revisions, persist artifacts atomically. Examples must never encode post-decision mutation outcomes as predictor features. Node/Python should reject unsupported feature versions and nonfinite numbers. C should mirror exported input/output schemas in Pydantic and test against the generated artifacts.

`featureVersion = sortfm.features.v1`. Exact ordered key list is exported as `FEATURE_KEYS`; missing means null/omitted, with masks derived during preprocessing. **0 is a valid observation**. Named values: saved_age_days, release_age_years, duration_ms, artist_library_count, top_track_short, top_track_medium, top_track_long, top_artist, recent_play_count, energy, danceability, happiness, acousticness, instrumentalness, liveness, speechiness, tempo_bpm, loudness_db, key_sin, key_cos, mode_major, soundnet_popularity, kept_centroid_distance, removed_centroid_distance. SoundNet percentages normalize to [0,1]; happiness is its own field, not renamed valence. Counts describe only observed windows. Partial provider results must preserve missingness.

Feature vectors record provenance, permittedForTraining and optional rightsBasis. The project owner stated source review/authorization is handled; no source-specific implementation ban is imposed. Adapters supply truthful provenance. FastAPI is a transport/service boundary; source provenance still follows the input data.

## Database inputs and integration sequence

`db.ts` defines exact input schemas for track upsert, saved snapshot, exposure insert, decision command, mutation transition, feedback revision, audio features, model run, import progress and telemetry. DB snake_case columns may map to camelCase DTOs. D supplies persistence implementations; `packages/db/src/index.ts` currently exports only input types and `DATABASE_IMPLEMENTED=false`.

Save user ownership in every scoped query; never authorize by `trackId` alone. Preserve original saves on resync. Use compare-and-swap transitions for mutation state. Keep command idempotency constraints in relational tables; Timescale uniqueness constraints must include the time partition key, so analytics gets a separate telemetry table. Fall back to plain PostgreSQL/date_trunc when Timescale is unavailable.

Next: A1 auth/import, B1 interface, C1 real model, D data/ingestion can work concurrently once the foundation handoff is PASS. They consume this published contract; agreement by those external sessions has not yet been confirmed. Integration lead resolves proposed amendments before field renames. Live accounts/keys, database migrations and deployment verification remain separate acceptance gates.

## Verified Spotify adapter references

Use `GET /me/tracks?limit=50&offset=...`, `POST /me/playlists`, `POST /playlists/{id}/items`, `DELETE /me/library`, `PUT /me/library`, `GET /me/library/contains`. Library endpoint references specify comma-separated `uris` query parameters (max 40); save/remove return empty HTTP 200 bodies. Playlist insertion uses JSON `{uris:[...]}`. The migration guide's library example differs from endpoint references: A must smoke-test reference behavior before live mutations.

Primary references: [2026 migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [saved tracks](https://developer.spotify.com/documentation/web-api/reference/get-users-saved-tracks), [save library](https://developer.spotify.com/documentation/web-api/reference/save-library-items), [remove library](https://developer.spotify.com/documentation/web-api/reference/remove-library-items), [contains](https://developer.spotify.com/documentation/web-api/reference/check-library-contains), [playlist creation](https://developer.spotify.com/documentation/web-api/reference/create-playlist), [playlist insertion](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist).

## Auth and import persistence boundary

`@sortfm/contracts` exports the type-only `A1Store` and `A1Transaction` port, based on A1 commit `d4be70c` with the agreed membership-completion operation below. The associated account, session, OAuth attempt, import job/observation/membership, summary and taste-context types are in `packages/contracts/src/persistence.ts`. These are internal server persistence records, not browser DTOs or new HTTP endpoints. Account token fields and OAuth verifier fields contain encrypted values; session/state/browser identifiers are hashes. No credential value belongs in a public response.

D implements this port in `packages/db`; A1 consumes it through compatibility type re-exports from its local `auth/store.ts`. This keeps database packages independent of API application modules. Transaction callbacks require serializable atomicity, detached reads, rollback on failure and owner-scoped data. They perform no provider I/O. Preserve original save dates and prior review status on repeat import. Raw observations use `(userId, jobId, pass, offset)` so rescans retain separate snapshots. This additive TypeScript-only export does not alter wire schemas, generated JSON schema or contract/feature versions.

`completeImportMembership({userId, jobId, pass, trackIds, sourceTotal, observedAt})` publishes the current library separately from retained snapshots. Call it only inside the successful job-completion transaction, fenced by the current job/pass and lease. `trackIds` contains unique normalized members from the reconciled complete scan; `sourceTotal` is the provider total including rejected/null/local entries. Failed, partial or superseded scans must not replace membership. A successful empty scan clears current membership. External unlikes never delete original save timestamps, raw observations or review/history records.

`LibrarySummary.total` means the latest confirmed provider library total, updated after a complete sync and subsequently by confirmed idempotent library mutations. It is not a streaming count and the sync-status endpoint supplies freshness/progress. `remaining` counts current known members eligible for review; unresolved/unavailable raw entries are not review candidates. `reviewed` and the action counters describe retained effective completed decisions; undone, pending and failed decisions do not count. Counts refer to different populations, so there is no `total = reviewed + remaining` invariant. Consumers must use `remaining` directly, without deriving it or a completion percentage from historical reviewed counts. Confirmed mutations/undo update membership independently of retained review state and must not double-adjust the count on retry.

### Import membership revision fence (server persistence only)

Every import pass captures `A1Transaction.getMembershipRevision(userId)` before its first provider page and persists it as `ImportJob.membershipRevision`. Resume preserves that baseline; a null/missing legacy baseline or changed revision requires a fresh scan. Final publication supplies required `ImportMembership.expectedMembershipRevision` and compares it under the same owner lock used to create destructive review/Undo work. Stale snapshots fail with `IMPORT_MEMBERSHIP_CHANGED`; unresolved destructive work (including expired leases) fails with `MEMBERSHIP_MUTATION_PENDING`. A1 treats either as retryable and rescans safely. Publication cannot overwrite a provider mutation awaiting local settlement. Successful publication and confirmed destructive COMPLETE/UNDONE settlements increment the revision in the same transaction, including when no prior library-state row exists. Public wire schemas and version 1.0.0 are unchanged.
