# B2 provider heading handoff

Branch: `b2-provider-heading`. Base: root-owned reader contract `e65b147a9dac4540a7eca33ffacf3326f1e50bd4`, following runtime `7860101`.

The inspector's audio enrichment heading now uses the validated `AudioFeatureStatus.provider`: SoundNet or Musicae. Missing audio status uses the neutral “Audio enrichment” heading. Counts, provider status, missingness, failure reasons, model metrics and styling are unchanged. This does not assert that a provider is configured or working.

Changed files:
- `apps/web/src/components/Insights.tsx`: provider-derived display name.
- `apps/web/src/components/inspector.test.tsx`: both supported providers with empty/quarantined metrics, plus absent-provider rendering.
- This handoff.

Verification: root typecheck, web lint (33 files), web/API production build and foundation HTTP smoke passed. Full Bun suite: **590 passed, 78 skipped, 0 failed; 3,174 assertions**. Inspector subset: **11 passed, 54 assertions**. The two existing Zod build annotation warnings remain.

No shared contracts, backend, deployment configuration or provider state were edited. Merge/cherry-pick only after the root reader contract is available. The contract base is inherited, not authored by B2. This minimal text change is verified through rendering tests; production browser acceptance is not claimed, and no real provider requests, personal labels or Spotify actions were made. No merge to main/foundation was performed.
