# C1 backend adapter

Server-only bridge from D's repository to the frozen Python C1 API. This directory owns transport, feature assembly, deterministic feedback splits, and snapshot forwarding. A2 owns queue/review routes, exposure persistence and durable feedback delivery; the integration lead owns runtime configuration. Listening coverage uses the additive server-only contract from `613a47e`; the feature schema, Python inputs and public exposure DTO remain unchanged.

The [public reads registrar](READS.md) adds authenticated insights and analytics GETs with actual metrics, library summary and audio progress. Root installs it; no retraining or mutation endpoint is added.

The separate [explicit retrain registrar](RETRAIN.md) implements the existing POST using the authoritative persisted feedback snapshot, owner/CSRF checks, bounded waits and validated fit results. Root installs it independently of the read-only registrar.

## Runtime wiring

Import from `./ml` inside the API only. Inject configuration from the server's composition root; this module reads no environment variables and contains no credentials. By default, `createMlClient` requires HTTPS except for HTTP loopback (`localhost`, `127/8`, `::1`). Redirects are refused so bearer credentials cannot follow a redirect. Existing HTTPS and loopback URL base paths remain supported.

For deployment within Railway's private network, the server may explicitly pass `allowRailwayPrivateHttp: true` with an origin such as `http://ml.railway.internal:8000`. The option defaults to false and accepts only a boolean. The new HTTP exception requires a valid ASCII DNS subdomain of `.railway.internal`, an optional port from 1–65535, and no path other than an optional trailing slash. It rejects credentials, query/fragment syntax, encoded hostnames, normalized dot paths, backslashes, malformed labels, suffix spoofs, public hosts and remote IP addresses. It does not enable generic remote HTTP or change HTTPS/loopback behavior.

[Railway documents](https://docs.railway.com/networking/private-networking) internal service DNS, encrypted Wireguard transport and environment isolation. This opt-in relies on that deployment environment; it does not establish network isolation by inspecting a hostname. Root owns the server-only environment flag and must explicitly pass the parsed boolean to `createMlClient`. The client itself reads no environment flag. Bearer authentication, redirect refusal, request/response validation, deadlines and single-attempt behavior remain active. Tests inject a fetch implementation to inspect the exact internal request; they do not contact Railway or verify a deployment.

```ts
import {assembleLibraryCandidates, createMlClient, createRepositoryMl, feedbackSplit} from './ml';

const client = createMlClient({
  serviceUrl: config.mlServiceUrl,
  sharedSecret: config.mlSharedSecret,
  timeoutMs: 10_000,
});
// D Repository structurally satisfies this port after D's implementation is integrated.
const ml = createRepositoryMl({repository, client, evaluationSeed: 42});

const rows = await repository.library(authenticatedUserId);
const allCandidates = assembleLibraryCandidates(rows, {
  userId: authenticatedUserId,
  now: new Date().toISOString(), // Freeze once, before creating the exposure.
  metadataTraining: {
    permittedForTraining: true,
    rightsBasis: 'Project owner attested source-use authorization for this personal project on 2026-11-07.',
  },
  // tasteContext: user-scoped cached A1 TasteContext, when available
});
// A2 filters eligible tracks, applies its policy, and assigns immutable exposure IDs.
const candidates = allCandidates.slice(0, 20).map(candidate => ({
  ...candidate, exposureId: crypto.randomUUID(),
}));
const scored = await ml.score(authenticatedUserId, candidates);
// Persist candidates' exact features and the matching returned predictions in D.
const split = feedbackSplit(authenticatedUserId, candidates[0]!.trackId, 42);
// Supply split to D settlement; preserve an existing track's split on later decisions.
```

The example's permission assertion is the project owner's recorded personal-project attestation. Deployment must inject the actual applicable permission; omission defaults to `permittedForTraining: false`. SoundNet audio must independently carry permitted provenance in D. Scoring is possible when training permission is false, but the service will not train on those features.

Use the authenticated backend user ID, never an unchecked browser-supplied identity. Assemble from the full distinct current library before queue filtering so primary-artist counts describe the library. The example's slice only illustrates the scorer boundary; A2 owns candidate selection and ranking. Client responses are keyed by track ID; consumers should match those IDs rather than assume response order. Keep batches at the contract maximum of 10,000.

## Features and missingness

- Metadata: elapsed save age, release year age, duration, and primary-artist library count. Neither current mutation status nor current decisions become predictors or labels. Old age alone does not imply dislike; C1 governs the weak recent-save prior.
- Audio: only validated, already normalized musical descriptors from permitted compatible `soundnet`/`licensed` sources (or synthetic audio for synthetic tracks). Invalid fields become null individually; absent or unpermitted audio degrades to metadata. Zeros remain observations. Audio does not override metadata or supply externally computed centroids.
- Listening context: optional owner-matched A1 recent-play sample fetched within 24 hours, containing at most 50 validated Spotify events. Deduplicate each track and timestamp instant, including offset-equivalent timestamps. Only positive matched counts within the trailing 30-day inclusion window reach `recent_play_count`; absent tracks and empty samples remain missing. This window is a filter over an incomplete sample, not a claim of 30 days of history. Malformed, future, stale, failed or foreign-owner context supplies no listening features. Recent plays remain observations, never Keep labels. No top-track labels or synthetic listening history are inferred.
- No provider request, enrichment wait, fitting, or feedback fetch occurs in `.score()`.

## Cached listening for new exposures

`prepareListeningContext(raw, {userId, now})` validates an unknown cached value and returns `{tasteContext, listeningContext}`. The usable context is detached, sorted, deduplicated and filtered; the separate `ListeningContextSnapshot` preserves original sample counts and freshness. `readCachedTasteContext(reader, options)` performs one owner-bound cache read through a structural `getTasteContext(userId): Promise<unknown>` port. Its default deadline is 1000ms; optional `cacheReadTimeoutMs` accepts integer values from 1–60000. Read rejection or expiry returns `read_error` with null context and unknown counts. Late resolution/rejection cannot replace the result, and no retry occurs. The deadline bounds waiting; the database remains responsible for canceling its underlying query.

Root can wire A's asynchronous `load` boundary as follows, once D's cache reader is present:

```ts
import {assembleLibraryCandidatesWithListeningContext} from './ml';

const cachedContextReader = {
  getTasteContext: (userId: string) => a1Store.transaction(tx =>
    tx.getTasteContext ? tx.getTasteContext(userId) : Promise.resolve(null)),
};
const load = (rows: Parameters<typeof assembleLibraryCandidatesWithListeningContext>[0],
  {userId, now}: {userId: string; now: number}) =>
  assembleLibraryCandidatesWithListeningContext(rows, {
    userId, now: new Date(now).toISOString(), metadataTraining,
  }, cachedContextReader);
// load returns {candidates, listeningContext}; it never scores, fits or observes.
```

Read once per fresh batch and persist the returned coverage beside each exact candidate feature snapshot. Keep it on server-only exposure, frozen calibration-candidate and adaptive-draft records; it does not enter the feature vector or Python request. Existing exposures, saved batches, labeled vectors and model artifacts must be replayed unchanged without another cache read. The synchronous assembler remains compatible and applies the same listening validation when supplied `tasteContext` directly, but durable coverage requires the asynchronous result above (or separately retaining `prepareListeningContext`'s snapshot).

Coverage statuses are `fresh`, `missing`, `read_error`, `owner_mismatch`, `invalid`, `provider_error`, `future` and `stale`. Fresh samples report cached, distinct and in-window event counts; a fresh empty sample truthfully reports zero sample events while every per-track count stays missing. A validated but unusable owner envelope retains its original fetch time and cached sample size, with usable event counts unknown. Foreign-owner or malformed context retains no cache metadata. No raw provider errors or listening event identities enter the coverage record. The clock and permission are copied before awaiting cache access.

## Feedback and immutable exposure rules

`ml.fit(userId)` reads D's `trainingExamples(userId)` once and forwards its atomic `{feedbackRevision, examples}` snapshot. It preserves exposure-time features, labels and split assignments; it never rebuilds training rows from today's library or newly enriched audio. Use it after D has committed a new effective-feedback revision. Full snapshots correctly remove labels superseded by SKIP or Undo. A null-label `/observe` upsert alone does not remove a different older decision's strong label, so A2 should use full fits for those transitions.

`ml.observe(event)` is available for correctly ordered, idempotent explicit decision events. **Do not deliver both fit and observe for the same revision.** A2 owns the persistent outbox, retry order and recovery. On `STALE_REVISION`, reconcile against D's latest committed snapshot rather than repeatedly retrying obsolete input. Never invent a revision or label to make a retry succeed.

`feedbackSplit(userId, trackId, evaluationSeed)` matches C1's SHA-256 assignment exactly. Keep the seed fixed and persist a track's first split; do not move holdouts after viewing their performance.

Assign exposure IDs before scoring and retry the original assembled candidates unchanged, including clock-derived values. C1 remembers the first prediction for each ID. Reusing an ID for new features or an incompatible pinned version fails with `EXPOSURE_CONFLICT`. Do not mix already scored exposures from different versions in one batch. If A2 falls back after a timeout, rotate the fallback exposure IDs because a late C1 call may already have recorded the original IDs. Persist fallback features and predictions in D and explain those stored fallback exposures there; C1 cannot explain IDs it never received.

`ml.evaluation(userId, modelVersion?)` returns actual C1 metrics, including its insufficient-data status. `ml.explain(userId, exposureId)` retrieves C1's immutable original prediction. Predicted probabilities remain uncalibrated; binary entropy is ambiguity, not a validated confidence interval. No adapter path fabricates metrics or changes Spotify's library.

## Failure handling

The client validates request/response DTOs and response identities, performs one request per call, and bounds fetch plus body reading with a deadline. `MlClientError` exposes safe `code`, `status`, and `retryable` fields without raw response bodies, credentials, or transport causes. Configuration, schema and identity failures are explicit. A2 controls bounded queue fallback and durable retry policy; the client does not silently replace learned predictions or retry mutations.

## Verification

Listening adapter verification on `a31cc32` plus root's `613a47e` contract: 83 focused feature/helper/coverage tests passed, with 236 assertions; full Bun suite 865 passed, 127 skipped, zero failed. Typecheck, root build, standalone ML module bundle and diff checks passed. Independent review found and verified the cache-deadline fix, then reported no remaining actionable findings. Live database/ML integration gates were disabled; no provider requests, fits, model promotions, artifact rewrites or production service changes were performed. Root owns integration of A's asynchronous boundaries and D's durable coverage/cache reader. Build retains the existing two Zod annotation warnings.

From the repository root:

```sh
bun test apps/api/src/ml
ML_ADAPTER_INTEGRATION=1 bun test apps/api/src/ml/integration.test.ts
bun run typecheck
bun run test
bun run build
bun build apps/api/src/ml/index.ts --target=bun --outdir apps/api/dist/ml
uv run --directory services/ml pytest -q
```

The opt-in integration test requires `uv` and the locked C1 environment. It starts its own loopback FastAPI worker and temporary artifact store using generated test credentials and synthetic rows, then verifies metadata cold start, fit, scoring, immutable exposure replay/explanation, evaluation, revoke replay and user isolation. It cleans up its own worker/store. It contacts no database or external provider.

Unit tests exercise D-shaped nullable-audio rows and a structural repository port. Live Tiger Data access, Spotify/SoundNet ingestion, production networking and real-user predictive quality are not established by these tests. C1's existing Python module and experiments are unchanged; see `services/ml/README.md` for training, evaluation, serving and measured limitations.

Verified on 2026-11-07 on base `fd5aba2`: focused adapter suite 104 passed (plus the separately enabled real-service test); full suite with `ML_ADAPTER_INTEGRATION=1` 191 passed, 1 existing A1 PostgreSQL test skipped, 0 failed; Python 214 passed. Root typecheck, root web/API build, standalone adapter bundle and diff checks passed. The web build reports two pre-existing Zod comment-annotation warnings. An independent read-only review found no actionable issues. Integration lead can apply this directory's commit without changing Python C1/C2 or shared contracts.
