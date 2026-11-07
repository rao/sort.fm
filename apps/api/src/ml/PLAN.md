# C1 TypeScript adapter plan

Scope is apps/api/src/ml only, canonical fd5aba2, D repository a910173. Python C1 and C2 remain untouched. Integration lead owns app/config/runtime; A owns queue/review routing, exposure persistence, feedback delivery.

- Build typed private client for five frozen C1 endpoints with validation, deadlines, redirect refusal and safe errors. Test transport and identity failures before implementation.
- Assemble current metadata and optional permitted normalized SoundNet descriptors from structural D library rows; leave unavailable history null/omitted. No pseudo-labels or mutation-status predictors. Explicit caller-provided metadata permission; no provider permission invented.
- Expose deterministic feedbackSplit identical to Python and a repository adapter for atomic trainingExamples snapshots. Preserve exposure-time features exactly for training, do not augment them with current library/audio data.
- Publish concrete A1 queue scorer with immutable candidate exposure IDs and injected metadata context; no public route or bandit implementation.
- Run focused tests, full tests/typecheck/build, real loopback FastAPI client integration, independent review, then commit only this directory.

Review focus: cross-user source snapshot mixing, accidental future/stale listening data, unpermitted/malformed provider fields, stale revision races, model/track identity mismatch, auth-secret forwarding through redirects, unbounded body timeout, and skipped/undone label reappearance.
