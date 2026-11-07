# Shared contracts 1.0.0

The source of truth is `packages/contracts/src/{schemas,features,db,routes}.ts`. TypeScript types are inferred from Zod. `bun run contracts:export` writes `packages/contracts/generated/contracts.schema.json` for Python and other consumers. JSON Schema cannot express every Zod cross-field refinement: the invariants here remain normative. Change field names through the integration lead and regenerate artifacts together.

The same command writes `packages/contracts/generated/demo-bootstrap.json`, a deterministic cross-language fixture matching the live bootstrap response shape. Timestamps/IDs in that artifact are fixed examples; HTTP routes generate fresh served timestamps/exposure IDs.

Wire JSON uses camelCase; dates are UTC ISO 8601 strings (offset input is accepted). UUIDs identify decisions, commands, exposures and events. Internal IDs allow letters, digits, colon, underscore, hyphen and period; dotted legacy Spotify usernames such as `ram.in` must round-trip unchanged as `spotify:ram.in`. Slash, backslash, spaces and URL query delimiters remain invalid. This additive prelaunch correction preserves contract/feature versions and is mirrored in Python. `trackId` is the 22-character Spotify ID or an explicit `demo:` ID. Synthetic track `spotifyUri` is always null. A Spotify card's URI must match its ID. No Spotify popularity or removed relinking fields are required.

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
