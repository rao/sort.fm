# Musicae ingestion implementation plan

> Execute inline with superpowers:executing-plans. The user approved proceeding with Musicae Pro after the measured pilot and explicitly authorized coordination with root/A1. Preserve D ownership; root owns shared DTO amendments and live rollout acceptance.

**Goal:** Enrich the imported library through resumable five-track batches, prioritizing likely next-session candidates without blocking review/calibration.
**Architecture:** Separate Musicae job, request-evidence and cache records. A durable provider-wide lease serializes request starts and bounds concurrency at one initially; at least one second between starts. Persist raw responses before projecting job results, so a restart can finish normalization without another provider call. Fence expired requests and retain indeterminate/crashed attempts. Preserve existing SoundNet records and immutable exposure snapshots. Root supplies additive provider/provenance enums; preserve current feature keys and omit valence/happiness conversion until an explicit contract exists.
**Tech stack:** Bun, TypeScript, existing parameterized PostgreSQL; no new dependencies.
**Spec:** User's 2026-11-07 Pro rollout request and ../musicae-provider-diagnostics/2026-11-07/DIAGNOSTIC.md, with master persistence/resumability constraints.

## Controls

Five IDs maximum per HTTP request. Default 30s timeout, bounded 1–120s; bounded response bytes; no redirects or hidden HTTP retries. Numeric range, exact ID/URI, expected duration and duplicate/unrequested ID checks. Preserve missingness; suspicious all-hundredth unit vectors plus whole-second duration are quarantined, never silently released to training. Source-specific rights basis server-side.

Separate quality states success/quarantined/unavailable/failed. At most three charged attempts per job; exponential jitter retry. Honor Retry-After and quota-reset headers; stop on auth/quota exhaustion, and open a durable circuit after three consecutive server/transport failures. Keep quota reserve; bound each CLI run by explicit request count. Recover stored responses without fetching again; expired requests with no response remain explicitly indeterminate and consume attempts.

## Tasks

- [x] Add failing provider/normalizer tests: bounded batches; null/out-of-order/duplicate/wrong-ID rows; 0/1 values; missing values; duration; no valence alias; suspicious precision; 429 and HTTP200 errors; timeout and body limits; no automatic retry.
- [x] Implement Musicae adapter/normalizer under apps/api/src/jobs/soundnet/musicae-provider.ts.
- [x] Add migration013 for separate queue/request/cache/control, then disposable DB tests for priority selection, idempotency, transaction fencing, crash recovery, raw-response replay, cooldown/circuit and no duplicate successful work.
- [x] Implement MusicaeQueue and bounded standalone worker/CLI; integrate a provider-aware cache projection into library reads, preserving SoundNet precedence and historical snapshots. Coordinate shared provider contracts/status with root.
- [x] Run unit/full tests, typecheck/build and disposable Tiger migration/recovery checks; independent review; commit D-only implementation and exact commands.
- [x] After root migration/runtime acceptance, run one Pro smoke batch, inspect quota/quality/latency; prewarm25 eligible upcoming candidates and then continue bounded bulk ingestion only while healthy. Verify resume, cache counts and existing-cache fingerprints; report quarantines/failures accurately.

## Integration proposal

Root: add musicae to provider/provenance enums and Python mirror/export, no feature key/version changes. D deliberately omits Musicae valence because happiness is a different provider field under the frozen contract. Root/A can wire MusicaeQueue.progress to the existing status surface after the additive enum. No OAuth, Spotify mutations, UI implementation or ML training in D.

## Verification before handoff

597 Bun tests passed, 5 integration tests skipped, 0 failed (3468 assertions) with disposable local PostgreSQL schemas. Targeted disposable Tiger Data suite: 16 passed, 88 assertions. Typecheck, web/API build and diff whitespace checks passed. Independent review identified five edge cases; each was fixed, with regressions for replay gates, coarse-feature detection, empty queues, HTTP classification and circuit behavior. No live Musicae requests or application-schema writes have occurred at this commit. Reader and migration deployment remain integration-lead gates.

## Live completion

The integration lead deployed migration013 and compatible readers before provider activation. The real Pro smoke, exact-order next-session prewarm, and bounded bulk run completed. A repeat run made zero provider requests. Existing SoundNet caches and baseline immutable exposures retained their fingerprints. Detailed request/quality/latency/quota evidence and the diagnostic report are private outside Git. The full-library completion-status correction is separately committed and integrated; runtime deployment remains owned by the integration lead.
