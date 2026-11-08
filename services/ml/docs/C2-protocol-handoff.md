# C2 snapshot integration handoff

Branch: `c2-policy-protocol`, worktree `sort.fm-c2-protocol`, starting foundation
`4a9face0a27004019e644b80517e274ebec641d5`. Implementation commit:
**`992f0bfd55ad29fc9f53a70ece9ca6466712db3c`**. Package **0.4.0**,
new-selection policy **c2-linucb-v3**, storage **schemaVersion=3**. C2-authored
changes are confined to `services/ml/**`. The earlier `c2-contextual-bandit`
worktree/history is preserved. No push, merge, production migration or activation
was performed by C2.

## Delivered boundary

Authenticated `/policy/associate` records an immutable committed cleanup event
against a refreshable exact current successful C1 fit receipt. It never invokes
`fit` or `observe`, changes C1 artifacts, or invents calibration rewards. Current
head/revision/fit-fingerprint checks reject stale or unpublished artifacts. Old
coalesced events enter inactive history; the latest original decision/exposure
sequence and an exact current permitted training example govern learning.
SKIP/Undo atomically close only the original lease. Historical retries and their
original acceptance timestamps remain immutable.

Fresh selections accept an optional revision for legacy compatibility; integrated
callers must supply a non-null version/revision pair. New decisions report the
actual bundle revision (cold is null). Every strategy uses common local safety
filtering. Existing C1 prediction/rank/model behavior within that pool, LinUCB
math, reward definition, and simulation algorithms are unchanged. The source
files `model.py`, `service.py`, `bandit.py`, and `simulate.py` have no changes.

See [C2-association-api.md](C2-association-api.md) for exact JSON, semantics,
compatibility, errors and operational constraints. `STALE_FIT_RECEIPT` (409) is
the only new service error code: refresh the receipt and retry the same event,
without refitting merely to deliver it.

## Actual verification

All fixtures and artifacts used for this work were synthetic and temporary.
No real listener outcomes, sealed cohort labels, private research bundles, or
provider credentials were used.

- Python: **589 passed in 39.92 seconds**, including all 454 foundation tests and
  135 new association/compatibility/evidence/wire tests. Existing C1 tests remain
  intact. Changed legacy policy fixtures now obey the approved common eligibility
  rule; historical v1/v2 replay still has dedicated preservation tests.
- Actual TypeScript Zod: **80/80 payloads** from 40 authenticated ASGI exchanges,
  including all four clock-rollback cases; revision-with-null-model is rejected.
  The repeatable capture helper is `tests/test_policy_wire_contracts.py`.
- Root Bun: **747 passed, 127 environment-gated skips, 0 failed**, 4,058
  assertions, 4.75 seconds. Default sandbox execution could not bind three
  localhost test servers; approved socket-enabled rerun passed. No external
  PostgreSQL integration environment was configured for this worktree.
- Root `bun run typecheck` and `bun run build`: **PASS**. Build retains the two
  pre-existing nonfatal Zod comment annotation warnings. Initial root checks
  lacked this worktree's packages; frozen-lock installation resolved that.
- New `scripts/smoke_policy_association.py`: **PASS, 33.52 seconds**, real
  authenticated localhost HTTP, including pinned selection, fit-only training,
  association replay, same-revision SKIP, inactive coalescing, Undo, release,
  actual 30-second expiry, restart and frozen predictions.
- Existing `scripts/smoke_ml.py` and `scripts/smoke_policy.py`: **PASS** on real
  localhost HTTP, preserving C1 and legacy C2 behavior. Socket access was approved.
- `uv lock --check --offline`, `uv build --offline`, `git diff --check`: **PASS**.
  Dependency versions are unchanged; only the package version changes in uv.lock.
- Fresh Python **3.11.12** virtual environment at
  `/tmp/sortfm-c2-protocol-wheel.CWQlJF`: installed the **0.4.0 wheel** offline.
  Isolated `python -I` from `/tmp` confirmed a `site-packages` import and passed
  published pins, association, receipt advancement, inactive replay, Undo,
  expiry and restart checks. It did not import the checkout.
- Independent final review found no remaining material correctness issue.
  Confirmed findings fixed with regressions: delayed associations must not erase
  a different newer legacy decision's reward, and repeated receipt verification
  should not repeatedly deserialize unchanged historical models.

## Measured performance

Synthetic 2,700-candidate/100-label workload, seed 42, five measured repetitions
after one excluded warm-up on local arm64/Python 3.11.12. The service benchmark
now establishes its one real policy reward through `/fit` + `/policy/associate`
and pins the measured selection to the actual fit receipt.

| Stage | Median seconds |
|---|---:|
| C1 fit | 0.010149 |
| C1 predictions | 0.294242 |
| Candidate contexts | 0.114958 |
| Policy rebuild | 0.019635 |
| Numerical selection | 0.031711 |
| Predictions + contexts + rebuild + selection | 0.465597 |
| Authenticated ASGI selection with persistence | 0.668281 |

[Raw samples and runtime metadata](c2-protocol-benchmark.json). Reproduce:
`uv run --offline python scripts/benchmark_bandit.py --size 2700 --training 100 --repeats 5 --seed 42 --output <report.json>`.
This shared host was concurrently verifying other work; these are descriptive
local measurements, not a matched regression experiment or latency SLA. ASGI
timing excludes sockets/TLS/deployed concurrency. No policy-quality improvement
was evaluated or claimed in this protocol patch; the earlier simulator's result
that LinUCB did not outperform C1 remains unchanged.

## Integration instructions and remaining gates

Root-owned prerequisite commits were cherry-picked without edits: `3a77223`,
`3112c89`, `1bdf86e`, `ef4ee0a`, `9a0fdd2`. Root already owns those contracts;
integrate the C2 implementation commit above and the accompanying documentation
commit rather than duplicating their contract work. C2 did not author shared DTO
changes. The approved additions include association/select revision fields,
`skip` closure reason, and preservation of wall-clock rollback snapshots.

Before enabling the reader, take a verified complete ML artifact backup.
Migration preserves v1/v2 decisions, fingerprints, predictions, version tags and
lease deadlines; it creates no association backfill. Downgrade requires restoring
the backup. Acceptance evidence still references its original immutable C1 fit.

Keep production C1 as default. A/D/root still own combined readiness: durable
committed-cleanup outbox, independent C1 fit acknowledgement, coherent database
eligibility and guarded publication/recovery, client error classification,
telemetry, and the disabled-by-default policy switch. The database must exclude
all permanent batch reservations and pending/reviewed/unsynchronized songs.
Lease expiry is neither provider cancellation nor database eligibility.

Crucially, a genuine first C2 adaptive intent can return `selectionMethod=c1`
with `trainedRewards=0` and `no_reward_observations`, while its frozen
`config.strategy` remains the requested adaptive strategy. Preserve that C2
exposure binding so its committed cleanup can seed the policy. A transport-fallback
unbound C1 exposure has no such policy proof and must not earn a C2 reward. Two
new regressions verify cold epsilon-greedy/LinUCB exposures seed their next choice.

No C2 service implementation blocker remains. A controlled real-account pilot
still requires the combined owners' integration tests and explicit activation.
Long-lived history/compaction, distributed deployment, real-provider mutation
flows and real-listener utility remain unverified. Receipt validation caches 128
small verified facts, never models; history beyond that working set can cause
repeated validation, and every read still scans history/stat metadata.
