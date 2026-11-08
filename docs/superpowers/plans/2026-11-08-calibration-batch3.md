# Batch 3 integration plan

## Boundary

Reuse existing durable calibration batches/items, frozen candidates, label/Undo commands and feedback delivery. Keep Batch 2 schemas, sampling output and routes unchanged. Do not merge experimental classifiers or change production C1. Batch 3 is one operator-created experiment:40 independently random permanent evaluation tracks, then20 diverse training tracks from the remaining eligible pool, with no uncertain-selection group.

## Protocol

1. Privately freeze the protocol, training/data/model references and one random seed commitment before reading the selection pool. Do not retry with another seed or pool to obtain preferable examples. Preserve explicit provenance and the original pool, ordering and model/feature versions.
2. Load the full library context once, then select only from a strict eligible identity set. Exclude all retained feedback including revoked/skipped history, earlier calibration exposures, permanent batch assignments/replacements, historical holdout identities, pending review/Undo and active known-track policy reservations. A prepared adaptive intent with no chosen track does not exclude its entire candidate pool. Require at least60 eligible songs.
3. Select the40 evaluation songs first with a seeded uniform sample; record40/N inclusion probability. Select20 diverse training songs from the remainder. Freeze complete candidates, observed/missing listening context, scores, pools and selection provenance without rewriting earlier labeled vectors.
4. Reserve atomically under the shared owner lock. Recheck feedback/membership revisions and the actual eligible identity digest, since serving an unlabeled calibration exposure need not advance those revisions. Reject drift with no partial reservation. Existing replay returns the saved reservation without assembling or scoring again.
5. Keep all60 cards and their labels/skips inaccessible while reserved. Only an operator can export the label-free40 and primary-artist sidecar for externally sealed research predictions. No browser reserve/seal endpoint exists.
6. Operator verifies exact artifact bytes and frozen candidate/feature identity, then submits an idempotent seal receipt. Persistence recomputes stored snapshot/pool/roster digests, verifies no intervening feedback, binds the external artifact hashes, and uses database time to open collection. Identical retries return the original seal; changed receipts conflict. Hashes attest identity, not the truth of an unverified caller assertion.
7. After sealing, the existing calibration UI can resume through an additive versioned read route and use existing label/Undo operations. An evaluation Skip never replaces or releases the original evaluation track. Training replacements use only the original frozen B pool with fresh eligibility checks and no rescore. All assigned tracks remain permanently reserved.

## Ownership and sequence

- Root: additive shared contracts, public read/skip registry and client, private operator receipts/scripts, integration checks and release.
- D: additive017 migration, reserve/seal persistence, current history/eligibility checks, private snapshots and DB admission gates. Never edit applied015.016 precedes017 through the normal migration runner; production activation requires an explicit reviewed migration plan.
- A: experiment service reusing cached assembly/scoring and existing calibration mutations, versioned read/skip routes, fixed40/20 selection entry point. Batch2 behavior remains unchanged.
- B: existing calibration page/store consumes reserved/ready state. No App routing overlap with the active UI workstream; predictions stay hidden while labeling.
- Research: private prespecified training and sealed predictions only. No production model promotion or outcome-based tuning.

The isolated C2 pilot must not race new reservations or source-account labeling. Its separate schema cannot see new production reservations, and revision counters alone do not solve that race. Keep actual pilot startup and Batch3 reservation/collection under one integration-owner coordination gate.

## Acceptance

Shared schemas reject wrong group sizes, overlaps, mixed model versions, evaluation replacements, malformed receipts and any preseal card leakage. Verify Batch2 compatibility. D tests migration rollback/reapply on a disposable schema, strict history exclusions, concurrent reservation rejection, preseal label/skip/renewal rejection, immutable snapshots, idempotent seals and permanent evaluation exclusion. A tests one assembly/score for initial reserve and none for read/seal/skip, unavailable-feature missingness and coherent scoring. B tests truthful reserved state, resume, labels/Undo, non-replacing evaluation Skip and unchanged Batch2. Root runs combined actual database/backend tests before any production migration, new panel selection or UI activation.
