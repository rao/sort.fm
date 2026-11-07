# C2 reservation lifecycle: approved service-local implementation

Status: **approved and implemented within `services/ml`; production activation remains disabled**. This follow-up addresses the integration audit finding that `c2-linucb-v1` permanently reserved SKIPs and abandoned selections. New scheduling uses `c2-linucb-v2` and policy storage format 2. Shared contracts, public selection-method enums, C1 schemas/model formats, and provider/database code remain unchanged. The original filename is retained for review history; this document now describes implemented local behavior. Verification results belong to [C2-handoff.md](C2-handoff.md).

## Implemented behavior

Permanent scheduling reservations are replaced by durable, bounded leases. The server default is **300 seconds**, configurable at startup through `ML_POLICY_RESERVATION_TTL_SECONDS` within the inclusive integer range **30–900 seconds**. These are operational defaults, not measured user-session requirements. A newly allocated exposure freezes its server UTC `reservedAt` and `expiresAt`. Client timestamps, repeated selection requests and later configuration changes cannot renew it. At `now >= expiresAt`, the lease no longer excludes the track; this alone does not establish backend eligibility.

Each original selection response and fingerprint remains immutable. Retrying an expired or released exposure returns that original selection, without reacquiring a lease. The backend must request a **new exposure ID** for new scheduling. Before serving a historical replay, the backend must inspect its lifecycle and check current database eligibility. The separate lifecycle object in exposure inspection leaves the original `/policy/select` request and response shapes unchanged.

The authenticated, service-local `POST /policy/release` operation closes only the specified exposure immediately. The backend should call it when a user skips or a prefetched item is discarded, using a durable retry/outbox command. If that command is lost, expiry still bounds lease exclusion. This implementation has no cooldown: the backend must omit a skipped track from the current session's candidate pool if immediate resurfacing is undesirable. A release is a scheduling operation, never a user preference, Undo, provider mutation, or cancellation.

Adaptive selection excludes a track while **any** of its leases is live. Separately, a committed C2 strong-review history for that track combined with an authoritative current C1 example suppresses completed reviews, including holdout examples. A newer C1 review remains protected even if its predecessor is revoked. Preexisting C1 training examples are not globally excluded: the current contract permits selecting pre-fit tracks. Backend current reviewable membership remains authoritative. Actual Undo/full-fit removal removes completed-review suppression when no current example remains. Valid Undo closes the revoked exposure's active lease, without resurrecting a terminal lease or closing a newer exposure's lease. Full-fit removal does not itself close a still-live lease.

Cold adaptive fallback receives the same lease treatment. Explicit `strategy=c1` preserves exact C1 ranking and bypasses reservation filtering. For compatibility with the existing implementation, a C1 selection still creates an exposure/lease that can affect a later adaptive selection. Backend uniqueness is required while policy filtering is disabled.

## Approved internal typed contract

These types describe service-local schemas, **not additions to shared TypeScript contracts**. The implementation uses the existing identifier, UUID, and timestamp validators, forbids extra fields, and preserves existing authentication/error envelopes. Exact Python schemas are in `src/sortfm_ml/policy_schemas.py`; route details are in [C2-api.md](C2-api.md). The backend derives and authorizes `userId`; the ML shared secret alone does not identify a listener.

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

// Frozen selection-time facts; null for migrated v1 decisions.
type PolicyEligibility = {
  evaluatedAt: Timestamp;
  filteringApplied: boolean;
  exclusions: Array<{
    trackId: Identifier;
    blockingExposureIds: UUID[];
    completedReview: boolean;
  }>;
};
```

Idempotency is scoped to `(userId, operation="policy.release", requestId)`. Store a canonical request fingerprint and immutable receipt before returning success. An identical retry returns that receipt; changed exposure/reason under the same ID returns 409. Unknown or another user's exposure returns 404 without revealing ownership. Releasing an already closed exposure with a fresh request ID returns `already_closed` and the original effective closure time. A stale release cannot close a later exposure for the same song. Receipts are historical outcomes and do **not** assert current track eligibility; another live lease or a completed review may still exclude it.

No response can substitute C2 design radius for C1 probability uncertainty. Existing C1 prediction snapshots and shared `Exposure.uncertainty` retain their meaning.

## Storage, recovery, and audit

- Leases and release receipts are separate from immutable `decisions` and C1 feedback. The existing per-user POSIX lock, checksum, and atomic-write mechanism are used. No background timer is required: selection, release, and exposure inspection reconcile expiration. For expiry, `closedAt`/`effectiveClosedAt` is the original `expiresAt`; `recordedAt` is when the server records the receipt. Observed terminal closures persist so a subsequent clock rollback cannot reopen them. A write failure returns an error rather than claiming a durable closure. A release's closure and receipt share one atomic write.
- Storage has independent `schemaVersion=2`. Verified v1 decisions migrate under the lock by validating their original `createdAt` and deriving `expiresAt = createdAt + 300 seconds` using a fixed migration constant, regardless of configured TTL. Old leases never restart at migration/startup time. Before serving, migration reconciles latest committed feedback against current C1 state and expiry; an already valid Undo cannot gain a live lease. Prior decisions, request fingerprints, prediction snapshots, feedback, and model versions are preserved exactly. Corrupt or unsupported artifacts return 503 with no silent reset. **Take a complete verified backup before migration.** No automatic pre-migration backup is created; downgrading to the old reader requires restoring that backup.
- New selections use `c2-linucb-v2` because action-set semantics change. Repairs of interrupted C1 prediction registration use the decision's original policy version, including v1. Context and reward versions stay unchanged.
- Each new decision has a canonical eligibility snapshot: server `evaluatedAt`, excluded track IDs, blocking lease IDs, and completed-review exclusions. Its digest contributes to `policyStateVersion`. Exposure inspection returns it separately from the immutable decision and current reservation. Legacy v1 inspection returns `eligibility=null`, without fabricating historical facts. Release receipts and closure facts are retained so an expiry-driven action-set change can be explained. Reproducibility requires the same seed, clock, candidate input, model, and lifecycle history.
- Expiry/release does not erase selection history, reset exploration quotas, or remove a selection from the diversity window. Selected and viewed remain distinct concepts. Retention/compaction is a separate design and remains out of scope.

Absolute UTC expiry assumes a reasonably synchronized service clock. Persisted closure prevents resurrection after observation; it cannot guarantee a real-time TTL under arbitrary clock failure. `PolicyService(..., clock=callable, reservation_ttl_seconds=300)` and `create_app(..., policy_clock=callable, policy_reservation_ttl_seconds=300)` support deterministic tests with aware datetimes. Production uses server UTC; deployment clock monitoring remains operational work.

## Feedback and mutation ordering

Accept delayed feedback after release/expiry under the existing C1 event/revision/idempotency rules. Never delete predictions, feedback intents, or learned rewards when closing a lease. Uncommitted intents do not earn reward or extend a lease indefinitely. SKIP remains unrewarded. Only current authoritative committed training examples affect LinUCB statistics. An old exposure's late release/Undo cannot clear a newer completed review or its lease.

The current adapter stages a feedback intent under a lock, then invokes C1 outside that lock. A finite lease cannot guarantee that an in-flight backend/provider operation has stopped. **Activation requires backend exclusion of pending review/Undo tracks and settled reviews awaiting ML synchronization, plus revalidation of reviewable database membership before serving or mutation.** Release is not cancellation or a mutation fencing token. A later C1 commit can legitimately make a previously released track completed; that completion suppresses further adaptive selection. The existing retry/reconciliation mechanism for interrupted C1 commits remains in place. No provider calls or database changes are included in C2.

**The existing A2 `FeedbackWorker` sends `/fit` snapshots and never `/policy/feedback` events.** C2 cannot infer committed reward or review history from those snapshots. Root/A/C2 must design one coherent feedback adapter before activation; do not bolt `/observe` beside `/fit` at the same revision. Lease expiry cannot establish eligibility while database state is newer than ML state. Expired or released selection replay must undergo lifecycle inspection and database eligibility validation before it is served. These gates are documented, not implemented in another owner's modules.

## Verification scope

The lifecycle suites cover the checks below. This list describes coverage, not new benchmark or test-count results; actual commands and results remain in [C2-handoff.md](C2-handoff.md).

1. Injected-clock expiry just before/at the boundary; restart; immutable select replay after closure; no retry/config-change renewal; observed closure survives clock rollback.
2. Release replay/conflicting IDs, malformed input, authentication, unknown/foreign exposure isolation, repeated release after expiry, and durable write failure.
3. Closing an old exposure does not close a new one for the same track; any other live lease still blocks selection. Concurrent select/release operations serialize correctly.
4. Abandonment and SKIP eventually permit reselection without reward; missed release still expires. Strong reviews stay suppressed past expiry; actual Undo permits reselection when no other live lease remains, while stale Undo protects newer reviews.
5. Delayed feedback for closed and superseded exposures, holdout reviews, full-fit removal, pending intents, interrupted C1 commit, and race scenarios involving release/select/commit/Undo.
6. Legacy migration preserves decisions/fingerprints/predictions byte-for-byte; old stale reservations expire immediately; bad timestamps/checksums fail closed. Retry repairs use original policy-version tags.
7. Cold adaptive leasing, exact disabled-C1 ranking, deterministic fixed-clock replay, lifecycle-sensitive policy-state hashes, and unchanged C1 uncertainty/training/version behavior.

The integration lead approved the isolated service-local implementation. Production activation stays disabled until the feedback transport, database eligibility/replay checks and public integration are designed and validated. The local branch remains unmerged; integration owns adoption.
