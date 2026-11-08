# C2 snapshot integration protocol

The integration-approved transport is `POST /policy/associate`. C1 continues to
receive complete `/fit` snapshots. Association never calls C1 `fit` or `observe`,
publishes a model, or changes a classifier recipe. Production remains C1 by
default; public activation and the database/API adapters belong to integration.

Canonical wire definitions are `packages/contracts/src/policy.ts`; the Python
mirror is `policy_schemas.py`. All policy routes require the service bearer token.
The API derives the owner from authentication. ML cannot independently prove a
Spotify mutation or distinguish calibration provenance from a fabricated cleanup
attestation; only the trusted backend may emit committed cleanup associations.

## Selection

Integrated calls supply both a non-null `modelVersion` and `feedbackRevision`.
They must identify the exact current published successful C1 fit, including a
non-null internal fit fingerprint. Loading a historical or unpublished artifact
is insufficient. Legacy clients may omit the revision. Fresh decisions record
the selected bundle's actual feedback revision; a never-fitted cold bundle
records `null`, and old decisions may omit the field entirely.

Every fresh policy (`c1`, `epsilon_greedy`, `linucb`, and the offline `random`
control) uses the same local live-lease and active-completed-review exclusions.
C1 ranking runs unchanged within that eligible pool. A successful fit alone does
not create policy review history. Database candidates must already exclude
pending reviews/Undo, active feedback, unavailable membership, permanent batch
reservations (including sealed evaluation songs), and unsynchronized completed
reviews. ML does not have that database state. Publication must revalidate it.

Exact historical selection replay is returned before checking the current pin.
It never reacquires or renews a lease. Inspect the lease and database eligibility
before serving a recovered decision; create a fresh exposure for new scheduling.

## Association request and receipt

```json
{
  "userId": "demo:listener",
  "event": {
    "eventId": "00000000-0000-4000-8000-000000000001",
    "sequence": 1,
    "source": "cleanup",
    "decisionId": "00000000-0000-4000-8000-000000000002",
    "exposureId": "00000000-0000-4000-8000-000000000003",
    "trackId": "demo:track",
    "policyVersion": "c2-linucb-v3",
    "modelVersion": "frozen-exposure-model-version",
    "operation": "upsert",
    "feedbackRevision": 12,
    "label": 0,
    "features": {
      "featureVersion": "sortfm.features.v1",
      "values": {},
      "provenance": "synthetic",
      "permittedForTraining": true
    },
    "occurredAt": "2026-11-07T23:00:00Z"
  },
  "fitReceipt": {
    "modelVersion": "current-published-fit-version",
    "synchronizedFeedbackRevision": 14
  }
}
```

`event.modelVersion` and `policyVersion` are the frozen exposure's versions.
The separately refreshable receipt identifies the current successful fit.
`sequence` is the durable per-owner policy outbox sequence, independent of C1's
revision: SKIP need not advance C1. Sequence gaps are allowed because other
outbox operations may occupy them. Distinct out-of-order events remain historical
evidence; the highest sequence for the original decision/exposure controls reward
eligibility. Reusing an event ID or sequence with different contents conflicts.
Each associated decision binds one original exposure, and vice versa.

Optional `usefulness` is a number in [0,1] only for a labeled upsert. No supplied
split is accepted. A receipt must cover the source revision and match the current
published C1 head exactly. Current C1 example decision, label, normalized frozen
features, training permission, and `train` split are all additional learning gates.
Absent/superseded examples are accepted as inactive history. Calibration has no
association hook or historical backfill; fit membership alone never awards reward.

The response is:

```json
{
  "userId": "demo:listener",
  "eventId": "00000000-0000-4000-8000-000000000001",
  "sequence": 1,
  "recordedAt": "2026-11-07T23:01:00Z",
  "duplicate": false,
  "fitReceipt": {
    "modelVersion": "current-published-fit-version",
    "synchronizedFeedbackRevision": 14
  },
  "eligibleForLearning": true
}
```

Fingerprint owner + immutable event, excluding the receipt. On replay,
`recordedAt` and original stored acceptance evidence remain unchanged;
`duplicate`, the supplied validated receipt, and current `eligibleForLearning`
describe this call. The same event can therefore become inactive after a later
fit without an idempotency conflict. `STALE_FIT_RECEIPT` (409) means refresh the
receipt and retry the same event; it does not instruct the worker to fit again.

SKIP is `upsert` with a null label; Undo is `revoke` with a null label. Neither
earns reward. Their event and targeted lease closure commit atomically. A live
lease closes with reason `skip` or `undo`, respectively; a previously expired or
released lease preserves its original terminal state. Closure never touches a
newer exposure for the same song. An Undo tombstone prevents older late upserts
from becoming rewards even if a subsequent snapshot repeats their example.
Immediate `/policy/release` remains independent of fitting, including cold SKIP
before any fit receipt exists. Defer that association until a genuine fit receipt
is available; do not fabricate a fit or an observation to acknowledge SKIP.

## Storage, versions, and compatibility

New decisions use `c2-linucb-v3` because the C1 policy's action-set filtering
changed. Storage schema 3 adds an `associations` ledger to the existing decisions,
legacy observation intents, reservations and release receipts. Each association
stores the immutable event fingerprint, server acceptance time, original fit
receipt and server-derived fit fingerprint. Fit evidence is checked against the
immutable C1 artifact. Reward/context versions and supervised algorithms remain
unchanged.

A bounded 128-entry cache retains only verified receipt facts, scoped by owner
directory and immutable version. Device/inode/size/mtime/ctime of both the model
and its checksum manifest invalidate an entry; changed evidence must pass C1's
artifact validation again. Model objects are not retained. Reads still scan
history, and more than 128 distinct accepted versions can cause cache eviction
and repeated deserialization. Unbounded-history throughput and compaction remain
unverified; this is a local single-replica protocol, not distributed persistence.

Verified schema 2 and legacy v1 ledgers migrate under the existing owner lock.
Schema 2 retains original lease deadlines. V1 derives original creation time plus
300 seconds. Neither migration creates association history, resets TTLs, rewrites
decisions, changes selection fingerprints, or adds fabricated revisions to old
decisions. Old v2 C1 selections retain their historical unfiltered eligibility
snapshot and replay unchanged. New selections always use current filtering.
Corrupt references/evidence fail closed. Back up the complete user artifact
directory before upgrade; rollback requires restoring that backup. No automatic
backup or compaction is provided.

Clock rollback does not reopen observed terminal leases. `evaluatedAt` is the
current wall clock and can precede issuance, closure or expiry. A release made
during rollback can have `closedAt < reservedAt`, including valid legacy v2
receipts. Preserve those times. Expired closure must still equal the original
deadline, and released closure must not exceed it; no replay extends the TTL.

Legacy `/policy/feedback` and policy-aware `/observe` remain available for isolated
online-observation clients. They still write C1 and must not be added beside the
snapshot worker. Association supersedes legacy reward copies of the same original
decision, avoiding double counting. Inspect `transport` to distinguish committed
association history from legacy observation intents. Reward remains 75% useful
review/completion proxy plus 25% frozen prediction correction; no deletion bonus,
unbiased off-policy estimate, or real-listener uplift is claimed.

## Errors and activation gates

- `STALE_FIT_RECEIPT` (409): head/version/revision mismatch or head was not a fit.
- `IDEMPOTENCY_CONFLICT` (409): event/sequence reuse or cross-transport event ID.
- `EXPOSURE_CONFLICT` (409): frozen identity/features or decision/exposure binding.
- `POLICY_EXPOSURE_NOT_FOUND` (404): unknown exposure for this owner.
- `NO_ELIGIBLE_CANDIDATES` (409): no candidate survives local safety filtering.
- `POLICY_STATE_UNAVAILABLE` (503): corrupt/missing policy or acceptance evidence.
- Existing `BAD_REQUEST` (422), authentication, C1 artifact and storage errors
  remain unchanged. A receipt numerically below its event revision is a malformed
  envelope (422); an obsolete but internally consistent receipt is stale (409).

Only `STALE_FIT_RECEIPT` is a new service error code. Keep C1 as the public default
until D's durable outbox/eligibility, A's worker/publication/recovery, inspector
telemetry and root's feature flag pass combined integration tests. This service
change alone does not establish controlled real-account pilot readiness.
