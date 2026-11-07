# C1 TypeScript adapter plan

Scope is apps/api/src/ml only, canonical fd5aba2, D repository a910173. Python C1 and C2 remain untouched. Integration lead owns app/config/runtime; A owns queue/review routing, exposure persistence, feedback delivery.

- Build typed private client for five frozen C1 endpoints with validation, deadlines, redirect refusal and safe errors. Test transport and identity failures before implementation.
- Assemble current metadata and optional permitted normalized SoundNet descriptors from structural D library rows; leave unavailable history null/omitted. No pseudo-labels or mutation-status predictors. Explicit caller-provided metadata permission; no provider permission invented.
- Expose deterministic feedbackSplit identical to Python and a repository adapter for atomic trainingExamples snapshots. Preserve exposure-time features exactly for training, do not augment them with current library/audio data.
- Publish concrete A1 queue scorer with immutable candidate exposure IDs and injected metadata context; no public route or bandit implementation.
- Run focused tests, full tests/typecheck/build, real loopback FastAPI client integration, independent review, then commit only this directory.

Review focus: cross-user source snapshot mixing, accidental future/stale listening data, unpermitted/malformed provider fields, stale revision races, model/track identity mismatch, auth-secret forwarding through redirects, unbounded body timeout, and skipped/undone label reappearance.

## Public read extension (base d6d55b4)

Implement only authenticated GET insights and analytics registrars using the existing route schemas. Reuse A2's shared session/origin/security helper. Root injects real getSummary, SoundNet progress, ML evaluation and optional D latestModel reads. Prediction stays null because neither route identifies an exact exposure. Reject client identity/query overrides; do not fit, score, mutate, query Spotify or enqueue enrichment.

On ML failure, a validated user-matched stored model run may supply historical counts/version; label it unavailable and clear numerical evaluation metrics. If no such snapshot exists, return a sanitized retryable 503: required integer counts cannot represent unknown values. Do not infer training state from library summary or from an absent model_runs row. Preserve real library counters independently, including remaining and total populations.

Verify auth/cookie/origin boundaries, fixed public response DTOs, actual data passthrough, unavailable and missing/corrupt snapshot cases, owner isolation, timeout behavior and no mutation dependencies. Root owns runtime registration; optional retrain is deferred to the existing automatic feedback workflow.
