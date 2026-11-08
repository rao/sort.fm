# C2 Integration Implementation Plan

> **For agentic workers:** Use the existing specialist ownership boundaries to implement and verify each task. Root owns shared contracts, runtime, review, and merges.

**Goal:** Prepare C2 for a controlled real-account pilot while C1 remains the production default.

**Architecture:** C1 continues receiving authoritative full feedback snapshots. A separate durable pipeline associates only committed cleanup decisions with genuine C2 exposures; it never calls C1 online observation. Every policy consumes the same database eligibility and publication checks. Selection telemetry is additive and distinct from classifier probabilities.

**Tech Stack:** Bun, TypeScript/Zod, Fastify, PostgreSQL/Tiger Data, Python/FastAPI, existing C1 and C2 artifact stores, React.

**Spec:** `../sort-fm-agent-handoffs/sort-fm-master-spec-v1.1.md`, C2 handoff, and the user's November 8 integration priorities.

## Global constraints

- Production defaults to C1; do not activate either bandit publicly during preparation.
- Preserve C1 supervised algorithms, model recipes, feature version, and the research experiment.
- Calibration labels are never retroactive policy rewards. Permanent Batch 2 reservations, including replacements, remain excluded.
- Keep provider credentials server-side. No production mutations, training runs, or migrations are needed for engineering verification.
- Preserve existing DTOs; optional telemetry must decode old exposures unchanged.
- Separate actual test evidence from readiness claims. Synthetic policies do not demonstrate real-listener improvement.

## Review focus

- An upstream selection may commit after a timeout: retry its exact durable request; a transient missing release target does not prove cancellation.
- C1 may advance between fit receipt and policy delivery: require exact model/revision validation and refresh the envelope without changing event identity.
- Undo may coalesce before policy delivery: keep historical association inactive and never resurrect a reward or another exposure's reservation.
- A pending Spotify mutation outlives a reservation: expiration cannot make its track eligible or cancel provider work.
- A legacy exposure may omit telemetry: the inspector must show unavailable state, not invented policy metrics.

## Task 1: Shared contracts and public telemetry (root)

**Files:** `packages/contracts/src/schemas.ts`, new `packages/contracts/src/policy.ts` and `policy-persistence.ts`, `packages/contracts/src/routes.ts`, exports/generated schemas, `packages/contracts/test/policy.test.ts`, `docs/contracts.md`.

**Interfaces:** Optional `Exposure.policyTelemetry`; internal select/associate/release/inspection schemas; server-only persistence ports shared by A and D. Existing `QueuePolicy` remains the UI preference enum and does not activate an algorithm.

- [x] Write tests for legacy decoding, epsilon-greedy method, separate unbounded C2 scores/radius, zero values, invalid lifecycle, and prediction identity.
- [x] Implement additive telemetry and publish its exact fields to B.
- [x] Freeze internal transport jointly with A/C2/D; validate immutable event identity separately from the refreshable C1 synchronization receipt.
- [x] Run contract tests, root typecheck, and regenerate JSON schemas.
- [x] Commit the reviewed boundary before specialist integration.

## Task 2: Committed association and policy lifecycle (C2)

**Files:** `services/ml/src/sortfm_ml/policy_schemas.py`, `policy_service.py`, `app.py`, policy tests and C2 handoff.

**Interfaces:** Authenticated association-only endpoint over a committed cleanup event and exact C1 synchronization receipt. Preserve existing selection/release/inspection APIs and immutable exposure predictions.

- [x] Test valid association without calling C1 fit/observe; reject mismatched owner, track, exposure, features, or synchronized model/revision.
- [x] Test coalesced upsert/Undo, supersession, repeated events, changed retry payloads, holdout non-learning, restart, and failed durable write.
- [x] Record historical committed events; reward only an exact current permitted training example. Undo and release affect only the original exposure.
- [x] Test identical eligibility handling for C1, epsilon-greedy, and LinUCB, including cold fallback, expired/released replay, and clock rollback.
- [x] Run the entire Python suite and policy smoke; preserve all C1 tests.

## Task 3: Durable eligibility, reservations, and delivery (D)

**Files:** New migration `016_policy.sql`, `packages/db/src/policy.ts`, settlement and feedback receipt hooks in `repository.ts`, exports, database tests.

**Interfaces:** `PostgresPolicyStore`: consistent candidate snapshot, prepare/publish/recover selection, release selection, claim/ack/retry ordered policy delivery. Exact type definitions live in the root-owned persistence contract.

- [x] Test one common eligibility predicate: confirmed membership/playability, no active feedback or pending review/Undo, no live reservation, no permanent Batch 2 assignment.
- [x] Persist exact selection requests before network I/O; publish an entire page atomically only after revision, membership, lifecycle, and identity revalidation.
- [x] Enqueue immutable policy events only inside committed cleanup settlement for bound review exposures. No calibration hook or historical reward backfill.
- [x] Persist validated C1 fit receipts without coupling C1 acknowledgement to policy availability. Lease/fence policy deliveries separately.
- [x] Test response loss, crash recovery, concurrent publication, stale acknowledgement, delayed mutation after expiry, committed Undo, and replay without renewal.
- [x] Rehearse migration application, rollback, reapplication, and preservation on a disposable database; never migrate production in this task.

## Task 4: Backend adapter and fallback (A)

**Files:** `apps/api/src/ml/client.ts`, `reviews/queue.ts`, new policy orchestration/worker modules, focused API tests.

**Interfaces:** Root-owned policy transport + D persistence port; queue returns unchanged C1 predictions with optional telemetry. Existing C1 feedback worker remains the only automatic full-fit writer.

- [x] Test all three policies against the same candidate/publication fixture and committed feedback contract.
- [x] Pin selection to an actual C1 model/revision pair; persist/retry exact selection intents and release discarded responses.
- [x] Deliver committed policy events only when a validated C1 receipt covers their revision; retry transport failures using immutable event IDs.
- [x] Fall back to C1 on disabled/unavailable policy capability, with truthful reason and new, unbound fallback exposure IDs.
- [x] Test delayed selection completion, invalid response identity, unsupported migration/capability, failed mutation, calibration isolation, and current-state revalidation.
- [x] Commit focused API changes with tests; root composes runtime.

## Task 5: Inspector (B)

**Files:** `apps/web/src/components/Insights.tsx`, `PolicyDetails.tsx`, inspector/policy-details tests.

**Interfaces:** Consume only `Exposure.policyTelemetry` and existing exposure identity/version fields. No browser policy switch or internal service secret.

- [x] Render real reward estimate, selection score, exploration bonus, policy uncertainty radius, policy/version identifiers and recorded lifecycle snapshot.
- [x] Label radius uncalibrated; do not format it or unbounded scores as probabilities. Explain reported lifecycle is an exposure snapshot, not proof of listening.
- [x] Test absent telemetry, null metrics, empty queue, zero values, radius above one, legacy refresh, and unchanged exposure identity after retrain.
- [x] Run web tests, lint, typecheck and production build.

## Task 6: Runtime and acceptance (root)

**Files:** `apps/api/src/config.ts`, `.env.example`, `runtime.ts`, runtime integration tests, smoke scripts, integration log.

**Interfaces:** Server configuration `C2_POLICY_ENABLED=false`, `REVIEW_SELECTION_POLICY=c1|epsilon_greedy|linucb` (default `c1`). Non-C1 selection requires the enable flag and verified optional database/ML capabilities. Missing optional capability falls back to C1.

- [x] Test invalid config, disabled-policy override, default C1, optional migration absence, and independent worker lifecycles.
- [x] Integrate focused commits incrementally; run contract/typecheck/tests after each merge.
- [x] Exercise real Fastify + disposable PostgreSQL + real local ML with synthetic data across all policies: select, commit, fit, associate, Undo, retry, release, expiry, restart.
- [x] Verify no calibration/sealed feedback reaches C2; C1 outputs and heldout routing remain valid.
- [x] Review full diff and run final root/Python suites, build, smoke, and public-repository secret/privacy checks before publishing.
- [x] Report technical pilot readiness separately from production deployment, flag activation, and real-account reward verification. Leave public policy at C1.
