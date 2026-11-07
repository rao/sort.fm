# Read-only prewarm priority

`readPrewarmPriority(port, userId, options?)` returns a plain JSON-serializable array of at most 25 unique Spotify track IDs. Root can serialize that array to its private operator file for D's `--priority-file`. This helper performs exactly one read through the supplied port; it never opens a file, queries a database directly, calls a provider/ML service, creates exposures, fits a model, or rewrites labels/features. Runtime/operator wiring stays with root. Provider caches, quarantines, terminal failures and in-flight exclusion stay with D's provider queue; consequently enqueue may accept fewer than 25 IDs.

## Read port

```ts
interface PrewarmPriorityPort {
  readPrewarmSnapshot(
    userId: string,
    query: {since: string; limit: number},
  ): Promise<PrewarmPrioritySnapshot>;
}
```

The snapshot contains:

- `userId`: the owner actually read, checked against the requested owner.
- `library`: current `CalibrationLibraryRow[]`, including imported ownership and metadata. Maximum 10,000 rows; larger snapshots fail explicitly.
- `eligibleTrackIds`: distinct authoritative IDs from current calibration eligibility. Exclude removed/unplayable tracks, active calibration labels, completed cleanup decisions (including SKIP), pending/retryable cleanup and every unresolved Undo, including expired leases. Never infer this set from exposure-time features or only the current review pointer. D's calibration candidate logic is the reference.
- `recentExposures`: at most 250 existing persisted/issued exposure summaries, each `{exposureId, trackId, purpose, servedAt, position, consumed}`. Purpose is `review` or `calibration`; mark consumption against the corresponding command namespace, including consumed exposures whose label/decision was later undone. No synthetic or newly manufactured exposures.

Root's adapter must read these fields in one consistent, owner-scoped snapshot, using the existing owner lock/transaction where necessary. Do not combine separate advisory reads across state changes. Read recent records at/after `since`, selecting newest `servedAt`, then purpose and ascending batch position before applying the 250-record bound. Existing same-purpose/same-`servedAt` entries form a batch for this read; equal-position ties use exposure ID. This reflects existing issued exposures, not proof that a browser displayed every card. No new schema or delivery marker is invented.

The port should filter consumed rows before its bound when practical so obsolete history does not crowd out usable recently issued cards. The helper independently filters them again. Missing authority (including unknown eligible IDs), duplicate library/eligibility/exposure identities, malformed metadata/IDs or excess input bounds fails closed with no output. An empty eligible set returns `[]`.

## Selection

Defaults: 25 output IDs, 30-minute recent window, `Date.now()` captured once. Options allow limit 1–25 and a positive recency window up to 24 hours. Root may supply a fixed millisecond `now` for a consistent operator snapshot.

1. Intersect current eligibility with current playable Spotify metadata, saved/deferred status and no completed/pending/retryable current cleanup decision. Pending Undo and active calibration labels must already be excluded authoritatively by the port.
2. Prefer unconsumed recent exposures, newest batch first, preserving ascending position within each purpose/timestamp batch. Ignore expired/future exposure timestamps for priority. Deduplicate track IDs in that order.
3. Fill remaining slots using the existing metadata-diverse calibration algorithm over the full eligible pool. Recent selections are skipped without rebucketing the remaining pool. Thus fallback order matches existing calibration selection. No model score or holdout/label value influences this ordering.

Expired or consumed exposures lose recent priority; an otherwise currently eligible track may still appear through diverse fallback. A snapshot is advisory after its read: root/D must handle state changes before enqueue. This helper does not promise future eligibility, provider availability, or a live session's exact eventual deck.

`selection.ts` factors the existing pure calibration selection without changing its policy ID or ordering. `CalibrationQueue` calls the same function as before; prewarming must never invoke `CalibrationQueue.get()` because that creates keyed exposures. This helper does not reorder cleanup review policy or alter UI behavior.

## Verification

Fixture tests cover mixed-purpose batch ordering, deduplication, current eligibility/status filters, consumed/expired/future priority, strict hard bounds, owner/identity corruption, empty output, exact fallback agreement with the existing calibration queue, one bounded read/no network and a 2,768-track library. No live database, provider calls, schema migration, operator file or serving model was used.

Run `bun test apps/api/src/calibration/prewarm.test.ts`, `bun run typecheck`, `bun test`, and `bun run build`.

Verified on base `28f3818`: 7 focused tests / 39 assertions; full fixture suite 589 passed, 78 environment-gated skips, 0 failed / 3,159 assertions. Root typecheck, web/API build, independent helper bundle and diff checks passed. Independent review found no actionable issue and reran prewarm/queue tests (14 passed / 89 assertions) plus typecheck. The web build retains existing Zod annotation warnings. Database adapter correctness, actual private export and provider enqueue remain untested here and owned by root/D.
