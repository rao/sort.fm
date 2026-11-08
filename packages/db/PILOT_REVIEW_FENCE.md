# Optional pilot review fence

This is an opt-in, server-only persistence guard. No migrations, environment defaults, model changes or runtime activation are included. `new Database(url,schema)` retains existing behavior. Root alone enables the pilot after independent setup/runtime checks.

## Wiring and manifest

Pass an explicit third constructor argument:

```ts
const db = new Database(pilotUrl, pilotSchema, {reviewExclusions: manifest});
const repository = new Repository(db);
const policyStore = new PostgresPolicyStore(db);
```

Manifest has exactly `{ownerId,pilotSchema,sortedTrackIds,sha256}`. Schema must equal the connection wrapper's configured schema and match `pilot_c2_` followed by24 lowercase hex digits. IDs must be unique, lexically sorted Spotify track IDs. Owner uses the existing IdSchema, including dotted Spotify owners. `sha256` is SHA256 of UTF-8 compact `JSON.stringify({ownerId,pilotSchema,sortedTrackIds})` in that exact alphabetical key order; export `reviewExclusionManifestDigest` computes it. No whitespace, newline or additional fields enter the hash.

Root derives sortedTrackIds from the already verified private snapshot's **reviewForbiddenIds**, then pins this owner/schema-bound digest in the private pilot startup receipt. It is a different digest from the helper's combined review/training exclusion manifest. A self-consistent caller hash is not independent authorization. Every process/restart must validate against the approved receipt; never silently regenerate a new policy from current data.

Constructor validation occurs before creating the SQL client. The policy copies its set into a private closure, exposes frozen methods/metadata, and makes the installed Database property/schema non-replaceable. No mutable Set escapes. The Database object must be shared by all pilot repository/policy/recovery workers. Raw SQL or a separately constructed unfenced Database can bypass application guards; this is not database row-level security. Root's restricted role, private schema and controlled startup remain required.

## Enforcement

- Common policy eligibility excludes forbidden IDs before computing remaining. Full library context and ML training rows remain unchanged. Existing PolicyQueueService uses this same predicate for C1, epsilon-greedy, LinUCB and C1 fallback.
- Before policy replay/publication/recovery, reconciliation invalidates any prepared/published intent whose frozen candidate pool or publication contains forbidden identities. It closes bindings and uses the existing adaptive abandonment outbox. Frozen payloads are never edited. Projection independently prevents serving any such intent. Recovery never returns the invalid draft for another model request.
- Direct Repository.insertExposure is disabled under the pilot fence. All new pilot review exposures must come from atomic policy publication, including C1/fallback.
- Repository.getExposure requires owner/track consistency, review purpose, a published binding and an intent publication containing the **exact JSONB exposure payload**. Containment or timestamp checks are insufficient. Source snapshot exposures have no matching pilot policy state and are rejected.
- Decision/Undo creation, existing decision/Undo getters used for HTTP replay, worker claim and settlement require the persisted original decision's publication membership and KEEP/SKIP action. Denied identities and inherited commands fail before new work or a lease. New decisions still require an active, unexpired binding through the existing policy-exposure guard. Consumed/closed memberships remain valid for legitimate previously recorded pilot retries and Undo.
- Training views/records, feature vectors, membership, saved status and historical audit records are not rewritten by this policy. Undo changes only legitimate pilot feedback through existing semantics.

A's isolated HTTP guard uses structural reads: getPublishedExposure maps to fenced Repository.getExposure, plus fenced getDecisionByIdempotencyKey/getDecision/getUndoByIdempotencyKey. It validates the request before ReviewService can return early or kick work. No new public DTO or bool admission API is needed. Persistence repeats checks atomically under the owner lock; preflight reads are not the final authorization.

Expected denial codes: REVIEW_TRACK_EXCLUDED, REVIEW_OWNER_MISMATCH, REVIEW_EXPOSURE_NOT_PUBLISHED, REVIEW_ACTION_NOT_ALLOWED. A maps these to terminal pilot403; unexpected database/storage errors remain fail-closed503. Normal idempotency conflicts keep their existing semantics.

## Mandatory external startup gates

Use a **new verified pilot schema** with no inherited policy intents/bindings/delivery events, review_work/leases/effects or pending commands. Source exposures and historical decisions may be retained for audit only. The membership proof relies on that zero-policy-state starting point; it is not a substitute for a per-run snapshot check. Pin the same manifest across process restarts. Pause source-account labeling/new Batch3 reservations under the integration lead's coordination gate; this fixed manifest cannot discover later source changes.

Require ready policy storage and PolicyQueueService for every strategy. Do not fall back to the legacy direct QueueService. Keep calibration/import/resync/provider/Spotify mutation routes disabled with root/A's pilot controls. If unexpected inherited work appears, worker admission fails closed; it does not delete, skip or run it. Treat this as pilot contamination requiring operator intervention.

## Verification boundary

Focused tests exercise manifest validation/immutability, absent default behavior, exact publication membership, inherited exposure/decision/Undo/work rejection, legitimate consumed-binding replay/Undo, all strategy selection/fallback, stale intent publication/recovery, and unchanged library/training snapshots. Actual tests use generated disposable schemas and synthetic data only. Existing unfenced policy/recovery tests verify compatibility. External ML transport is mocked in queue tests; no real provider or pilot runtime is started. Root owns combined HTTP/runtime/startup verification and production enablement.

Final branch verification: full `bun test`958passed/173skipped/0failed (5007 assertions); `bun run typecheck`, `bun run build`, and `git diff --check` passed. Separately,6 actual disposable pilot-fence tests passed86assertions, with a focused successful rerun adding purpose/mutation/consumed-binding checks;10 existing unfenced policy/recovery/decision database tests passed100assertions. Independent read-only review found no additional issues after the exact-publication-equality regression was reproduced and fixed. No production database changes, source copying, pilot startup or external model/provider requests were performed.

Integration note: this branch intentionally starts at872fe37, separately from D's Batch3 commitb2df3c0. When combining, preserve **both** optional pilot publication admission and Batch3 phase admission in Repository.getExposure. Do not resolve the overlapping method/import hunk by dropping either guard. Root owns combined A8c1beed/D/runtime verification.
