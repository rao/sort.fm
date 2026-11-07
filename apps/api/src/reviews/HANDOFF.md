# A2 queue slice

Depends on foundation `fd5aba2` and D `a910173` (locally cherry-picked as `d6ab6c0`). No root runtime, DB or shared-contract files changed by this slice.

## Wiring (integration lead)

```ts
const queue = new QueueService(repository, {
  assemble: (rows, context) => assembleLibraryCandidates(rows, {
    ...context,
    metadataTraining: configuredMetadataTrainingRights,
  }),
  score: (userId, candidates) => repositoryMl.score(userId, candidates),
});
const reviews = createReviewQueueModule({queue, auth: spotify.auth, config});
await reviews.registerRoutes(app);
```

Both assembler and scorer are optional. The built-in metadata snapshot does not infer training permission. C1 supplies assembly/scoring; root config supplies the explicit rights basis. Queue uses the server-resolved session account only. Register before any queue fallback. This registrar owns only `GET /api/queue`; demo stays on the existing explicit demo endpoint.

Queue reads D's current membership, selects playable saved/deferred Spotify tracks, excludes in-flight decisions, puts deferred tracks last, and persists each exact feature/prediction/exposure snapshot before returning it. Scoring has a 2-second deadline; failures never leak upstream text. Fallback rotates exposure IDs so late scoring cannot contradict a served baseline; scorer inputs are cloned. Every request gets new exposure IDs. No cursor is advertised because the frozen query contract has no cursor input: subsequent reads derive eligibility from durable decisions.

Selection is honestly `deterministic_baseline` for all requested policies until C2's selector is integrated. ML predictions can be shown without falsely claiming learned selection. Cold start probabilities are null. SoundNet completion is never required. `remaining` is eligible tracks before selecting the page.

## Verification

- A1 + queue tests: 51 pass, 2 opt-in DB skips, 515 assertions before the review fix; targeted queue rerun after the fix: 8 pass, 35 assertions.
- Separate live Tiger Data isolated-schema queue test: 1 pass, 7 assertions; exact snapshots survive repository reconstruction, foreign user cannot fetch exposure, immutable conflict rejected. Synthetic fixture only; no user tracks changed.
- `bun run typecheck`, `bun run build`, standalone reviews module Bun build: passed.

Independent code review found and verified the late-scoring identity fix; no outstanding findings.

## Remaining A2 work

Decision/history/Undo routes and Spotify mutation reconciliation are the next slice. D is adding a transactional, revision-keyed full-fit outbox; A owns delivery, C1 owns typed ML transport. Do not claim mutations or durable feedback delivery from this queue commit. Live owner OAuth and controlled real-track mutation checks still require the user's allowlisted Spotify account.
