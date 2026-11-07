# B2 P0 live frontend

Base: accepted foundation `fd5aba2`. Scope: `apps/web/**`. Live OAuth/provider mutations require owner consent; this work implements and tests the browser boundary against frozen contracts and controlled HTTP responses.

1. Validated credentialed HTTP adapter, account-scoped request journal, isolated explicit demo entry.
2. Session/connection/import UI and polling, then live review, persisted history/undo and refreshed metrics. Reuse B1 components and preserve all B1 tests.
3. Test no demo/live crossover, durable retry identity, no optimistic success, queue depletion, refresh failure, unknown history metadata, auth loss and import progress. Run lint/typecheck/tests/build and browser checks.

Contract constraints discovered before implementation:
- History returns ReviewResult records without TrackCard. Show a track ID and Open in Spotify fallback for records whose metadata has not been loaded; do not fabricate artist/title/exposure.
- Queue/history responses have nextCursor, but existing request schemas/client cannot accept cursor. Fetch a new queue after confirmed decisions, using server remaining; expose a bounded-history notice when a cursor is present. Cursor pagination requires an integration-owned additive contract change.
- React Query is not installed. Root dependency lock is integration-owned, while this workstream is restricted to apps/web. For this independently testable increment use a small read-only request cache/deduplicator with bounded GET retries. React Query adoption requires the lead to approve the dependency and update the root lock; no undeclared dependency or root edit is introduced.
- Analytics exposes current aggregates, not time series or ablation runs. Render actual supplied counts/metrics only; do not invent charts or endpoints.

Playback SDK and other P1 work are deferred. Open in Spotify remains available for real tracks.
