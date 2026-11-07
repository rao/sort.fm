# C2 reservation lifecycle: integration proposal

Status: **proposal only; not implemented or approved for activation**. The verified C2 runtime is unchanged. This addresses the integration audit finding that `c2-linucb-v1` permanently reserves SKIPs and abandoned selections. It does not change shared contracts, public selection-method enums, C1 schemas/model formats, or provider/database code.

## Recommended behavior

Replace permanent scheduling reservations with durable, bounded leases. The server default is **300 seconds**, configurable at startup within **30–900 seconds**. These are proposed operational defaults, not measured user-session requirements. A newly allocated exposure freezes its server UTC `reservedAt` and `expiresAt`. Client timestamps and repeated selection requests cannot renew it. At `now >= expiresAt`, the lease no longer excludes the track.

Keep each original selection response and fingerprint immutable. Retrying an expired or released exposure returns that original selection, without reacquiring a lease. The backend must request a **new exposure ID** to schedule another review. Add a separate lifecycle object to exposure inspection; do not append dynamic status to an immutable decision response. The original `/policy/select` request and response shapes can therefore remain unchanged.

Add an authenticated, service-local `POST /policy/release` operation. It closes only the specified exposure immediately. The backend should call it when a user skips or a prefetched item is discarded, using a durable retry/outbox command. If that command is lost, expiry still bounds exclusion. No cooldown is proposed in this minimal version: the backend must omit a skipped track from the current session's candidate pool if immediate resurfacing is undesirable. A release is a scheduling operation, never a user preference, Undo, provider mutation, or cancellation.

Adaptive selection excludes a track while **any** of its leases is live. Separately, a committed C2 strong-review history for that track combined with an authoritative current C1 example suppresses completed reviews, including holdout examples. A newer C1 review must remain protected even if its predecessor is revoked. Do not globally exclude every preexisting C1 training example: the current contract permits selecting pre-fit tracks. Backend current reviewable membership remains authoritative. Actual Undo/full-fit removal removes completed-review suppression when no current example remains; Undo must not resurrect an expired/released lease. Preserve the existing valid Undo behavior by closing the revoked exposure's lease when its track has no remaining current example, without closing a newer exposure's lease.

Cold adaptive fallback receives the same lease treatment. Explicit `strategy=c1` preserves exact C1 ranking and bypasses reservation filtering. For compatibility with the existing implementation, a C1 selection still creates an exposure/lease that can affect a later adaptive selection. Backend uniqueness is required while policy filtering is disabled.

## Internal typed contract proposed for approval

These types are illustrative service-local schemas, **not additions to shared TypeScript contracts**. Their implementation must use the existing identifier, UUID, and timestamp validators, forbid extra fields, and preserve existing authentication/error envelopes. The backend derives and authorizes `userId`; the ML shared secret alone does not identify a listener.

```ts
type PolicyReleaseRequest = {
  userId: Identifier;
  requestId: UUID;
  exposureId: UUID;
  reason: "skip" | "abandoned" | "prefetch_discarded";
};

type PolicyReleaseReceipt = {
  userId: Identifier;
  requestId: UUID;
  exposureId: UUID;
  trackId: Identifier;
  outcome: "released" | "already_closed";
  recordedAt: Timestamp;
  expiresAt: Timestamp;         // Original frozen deadline.
  effectiveClosedAt: Timestamp;
};

// Additive sibling of the existing immutable decision in /policy/exposure.
type PolicyReservationInspection = {
  exposureId: UUID;
  reservedAt: Timestamp;
  expiresAt: Timestamp;
  evaluatedAt: Timestamp;
  status: "active" | "released" | "expired";
  closedAt: Timestamp | null;
  closureReason: "explicit_release" | "undo" | "expiry" | null;
};
```

Idempotency is scoped to `(userId, operation="policy.release", requestId)`. Store a canonical request fingerprint and immutable receipt before returning success. An identical retry returns that receipt; changed exposure/reason under the same ID returns 409. Unknown or another user's exposure returns 404 without revealing ownership. Releasing an already closed exposure with a fresh request ID returns `already_closed` and the original effective closure time. A stale release cannot close a later exposure for the same song. Receipts are historical outcomes and do **not** assert current track eligibility; another live lease or a completed review may still exclude it.

No response can substitute C2 design radius for C1 probability uncertainty. Existing C1 prediction snapshots and shared `Exposure.uncertainty` retain their meaning.

## Storage, recovery, and audit

- Keep leases and release receipts separate from immutable `decisions` and C1 feedback. Use the existing per-user POSIX lock, checksum, and atomic-write mechanism. No background timer is required: reconcile expiration on selection, release, and exposure inspection. For expiry, `closedAt`/`effectiveClosedAt` is the original `expiresAt`; `recordedAt` is when the server records the receipt. Persist a terminal closure once observed so a subsequent clock rollback cannot reopen it. A write failure returns an error rather than claiming a durable closure.
- Introduce an independently versioned storage format. Migrate existing decisions under the lock by validating their original `createdAt` and deriving `expiresAt = createdAt + 300 seconds` using a fixed migration constant. Never start old leases at migration/startup time. Before serving, reconcile each legacy exposure's latest committed feedback against current C1 state: an already valid Undo must remain closed rather than gaining a live lease. Preserve prior decisions, request fingerprints, prediction snapshots, feedback, and model versions exactly. Reject corrupt or unsupported artifacts with 503; no silent reset. Document that downgrading to the old reader requires restoring the pre-migration backup.
- New selections use a new policy/scheduler version because the action set semantics change. Preserve original version tags when repairing old C1 prediction registrations; the existing `_ensure_prediction` uses the current global version and needs care during this change. Context and reward versions stay unchanged.
- Log a canonical eligibility snapshot with each new decision: server `evaluatedAt`, excluded track IDs, blocking lease IDs, and completed-review exclusions. Include its digest in `policyStateVersion`. Retain release receipts and closure facts so an expiry-driven change in the action set can be explained. Reproducibility requires the same seed, clock, candidate input, model, and lifecycle history.
- Expiry/release does not erase selection history, reset exploration quotas, or remove a selection from the diversity window. Selected and viewed remain distinct concepts. Retention/compaction is a separate design and remains out of scope.

Absolute UTC expiry assumes a reasonably synchronized service clock. Persisted closure prevents resurrection after observation; it cannot guarantee a real-time TTL under arbitrary clock failure. Use an injected clock for deterministic tests and deployment clock monitoring.

## Feedback and mutation ordering

Accept delayed feedback after release/expiry under the existing C1 event/revision/idempotency rules. Never delete predictions, feedback intents, or learned rewards when closing a lease. Uncommitted intents do not earn reward or extend a lease indefinitely. SKIP remains unrewarded. Only current authoritative committed training examples affect LinUCB statistics. An old exposure's late release/Undo cannot clear a newer completed review or its lease.

The current adapter stages a feedback intent under a lock, then invokes C1 outside that lock. A finite lease cannot guarantee that an in-flight backend/provider operation has stopped. **Activation requires backend exclusion of tracks with in-flight mutations and revalidation of reviewable membership before mutation.** Release is not cancellation or a mutation fencing token. A later C1 commit can legitimately make a previously released track completed; that completion must suppress further adaptive selection. Keep the existing retry/reconciliation mechanism for interrupted C1 commits. No provider calls or database changes are proposed within C2.

## Acceptance checks for the follow-up implementation

These are proposed tests, **not results**. Existing C2 verification remains recorded in [C2-handoff.md](C2-handoff.md).

1. Injected-clock expiry just before/at the boundary; restart; immutable select replay after closure; no retry/config-change renewal; observed closure survives clock rollback.
2. Release replay/conflicting IDs, malformed input, authentication, unknown/foreign exposure isolation, repeated release after expiry, and durable write failure.
3. Closing an old exposure does not close a new one for the same track; any other live lease still blocks selection. Concurrent select/release operations serialize correctly.
4. Abandonment and SKIP eventually permit reselection without reward; missed release still expires. Strong reviews stay suppressed past expiry; actual Undo permits reselection when no other live lease remains, while stale Undo protects newer reviews.
5. Delayed feedback for closed and superseded exposures, holdout reviews, full-fit removal, pending intents, interrupted C1 commit, and all meaningful orderings of release/select/commit/Undo.
6. Legacy migration preserves decisions/fingerprints/predictions byte-for-byte; old stale reservations expire immediately; bad timestamps/checksums fail closed. Retry repairs use original policy-version tags.
7. Cold adaptive leasing, exact disabled-C1 ranking, deterministic fixed-clock replay, lifecycle-sensitive policy-state hashes, and unchanged C1 uncertainty/training/version behavior.

Integration approval is needed for these TTL defaults, the release/inspection schema, migration, and backend mutation coordination before runtime changes or activation. The finalized C2 branch can be integrated experimentally with policy activation disabled while this follow-up is reviewed.
