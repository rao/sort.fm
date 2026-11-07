# B2 connected frontend completion

Base: approved canonical foundation `d6d55b4`; branch `b2-playback-inspector`; ownership `apps/web/**` only. Existing B1 and B2 P0 are retained.

1. Extend the validated HTTP adapter using only existing registry routes: playback status/play and retrain. Add regression tests for credentialed routing, validation, rejected responses and no automatic POST retry.
2. Add a capability-gated player in the existing footer. A click requests backend playback on an existing Spotify device. Confirm actual playback through status, handle no device/errors/recheck, suppress duplicate requests and prevent demo writes. No automatic playback on navigation or swipe.
3. Add explicitly requested model retraining, serialized with review state. Validate returned owner/version/counts; render real evaluation metrics, feature completeness, contributions and exposure-time model identity. Preserve honest unavailable states.
4. Exercise the production UI with the labeled HTTP fixture and integrated backend where available. Run root tests, typecheck, lint, production build and smoke. Commit a handoff with exact evidence and remaining external gates.

## Contract proposals for integration lead (not implemented as private endpoints)

- Native Web Playback SDK requires a Premium access token via `getOAuthToken` and an SDK device transfer. `docs/contracts.md` explicitly requires agreement on browser tokens before adding a token endpoint; current public routes expose neither token nor transfer and session playback is false. Keep credentials server-side. Existing `player/play` can support backend-controlled playback on an already active device, but cannot create an SDK device. Proposed lead-owned addition: explicit short-lived playback token boundary and validated device transfer route; document scope isolation, no-store, same-session authorization, token refresh and SDK-only in-memory use. Until approved, native SDK is blocked and Open in Spotify remains available. Reference: https://developer.spotify.com/documentation/web-playback-sdk/reference (checked November 7, 2026).
- Metrics do not include training positive/negative mix; holdout mix is not a substitute. Add explicit training class counts if required.
- Analytics has aggregates only; no time buckets or ablation experiments. Add a versioned series/ablation DTO including provenance, timestamps, model versions and nullable results before charts can consume it. Never synthesize real telemetry.
- React Query requires an integration-owned root lock update. This change retains the existing bounded HTTP adapter and introduces no dependency.
- Historical decisions have no metadata and no cursor input. Existing bounded-history notice and track-ID fallback remain.

## Baseline

Locked install made no tracked dependency changes. Root tests: 261 passed, 56 skipped, 0 failed when allowed to bind local sockets. Sandbox-only run had three socket binding failures; these passed unchanged outside the sandbox. Database/provider integration suites are opt-in.
