# Isolated review pilot integration

These server-only helpers are opt-in. Default application behavior is unchanged.
There is no new public DTO. Runtime activation is an explicit programmatic option.

## Required runtime composition (integration lead)

1. Build the immutable D pilot exclusion policy on an isolated database/schema.
   Require the exact owner and manifest digest, and empty policy bindings/intents
   on the initial copy. Enforce the same manifest on restart. An existing source
   exposure or timestamp is not pilot membership.
2. Require the durable PolicyStore and PolicyQueueService for **all** queue paths,
   including C1 fallback. D must verify the exact persisted publication, binding
   and exposure payload in the pilot schema, and enforce review purpose. D must
   repeat admission atomically at decision/Undo creation and worker claim, and
   fence inherited command/replay reads. The HTTP guard cannot fence a worker
   already reading copied historical work.
3. Create primary OAuth `SpotifyHttp` with
   `createPilotOAuthFetch(auditedFetch)` from `../spotify/pilot-transport`.
   This admits only exact POST token exchange/refresh and GET current profile;
   redirects are disabled. Do not give this OAuth transport to playback.
4. Create the Spotify module with `backgroundImportEnabled: false` **before**
   building the app. This disables automatic startup/recovery only. Explicit
   importer calls retain normal semantics and must not be invoked in the pilot.
5. By default, give Spotify mutation reads and writes `denyPilotProviderFetch`; it returns a
   local 403 without network I/O so existing adapters classify writes as rejected,
   not ambiguous. Use `createPilotPlaybackTransport()` for playback. Both token
   and API requests are denied. Use separate pilot sessions/secrets/artifacts and
   a separate browser profile; cookies are not isolated by port.
6. Pass a direct `buildApp.beforeRoutes` installer (not an encapsulated plugin):

```ts
beforeRoutes: app => installPilotGuards(app, {
  config,
  auth: spotify.auth,
  admission: {
    getPublishedExposure: (user, id) => pilotRepository.getExposure(user, id),
    getDecision: (user, id) => pilotRepository.getDecision(user, id),
    getDecisionByIdempotencyKey: (user, key) => pilotRepository.getDecisionByIdempotencyKey(user, key),
    getUndoByIdempotencyKey: (user, key) => pilotRepository.getUndoByIdempotencyKey(user, key),
  },
})
```

`pilotRepository` **must** have D's immutable pilot fence enabled. Ordinary
Repository methods on this base commit do not prove publication membership.
Wiring an unfenced repository violates the admission port contract. Runtime must
fail startup if the fence or durable policy store is unavailable. Guard installation
is awaited before health, demo, module routes, fallback routes or module startup.

## HTTP behavior

Exact GET health and primary OAuth start/callback are public. GET me, queue,
history, library summary, ML insights and analytics require a session. Queue
requires Spotify mode. POST logout retains normal CSRF checks. By default only
KEEP/SKIP and Undo of a pilot-published KEEP/SKIP decision reach review handlers.
The explicit mutation opt-in below also admits ARCHIVE/UNLIKE and their Undo.
Idempotency replay still validates persisted membership; a consumed/closed
published exposure can serve a legitimate replay/Undo, while a new command's
active-binding requirement remains in D's atomic write.

Everything else is denied before its handler, including import/status, calibration,
manual retrain, playback, demo, unknown routes and HEAD. Shared OAuth callback
rejects every `playback-` state. CORS preflight may succeed but performs no action.
Expected membership denials return terminal 403; conflicting command keys return
409; unexpected admission failures return generic retryable 503 without raw errors.
Normal auth and body validation remain 401/400; POSTs require same-origin CSRF.

## Verification boundary

Tests exercise Fastify injection, fresh PKCE login/session/refresh/logout against
fake Spotify responses, startup ordering/opt-out, route default deny, replay and
Undo admission, zero service/worker calls for rejected inherited work, and denied
provider transports. No real Spotify credentials, provider calls, pilot database
copy, live migrations or runtime launch were performed. D's actual persisted
membership implementation and root's runtime wiring require their own integration
verification before use. Existing full tests/typecheck/build remain required.

## Programmatic runtime activation

`buildRuntime` now composes these requirements when given an explicit pilot option:

```ts
const runtime = await buildRuntime({
  env: privatePilotEnvironment,
  pilot: {manifest, approvedManifestSha256: privateReceipt.reviewExclusionSha256},
});
```

No environment variable enables the mode. The caller supplies an independently
approved digest; supplying a self-computed matching digest does not establish
approval. Root remains responsible for receipt authenticity, fresh isolated secrets,
artifact directories, restricted database credentials, the verified initial copy
with zero inherited work/policy state, and the separate browser profile.

Startup validates the exact schema/manifest/Spotify owner allowlist, explicit demo
opt-out, distinct loopback API/web/ML origins, matching loopback host/API port, and
explicit usable token/session/ML secrets. Missing/mismatched configuration rejects
before connection. The manifest and environment are copied across startup awaits.
Database startup requires all foundation runtime relations through migration016 in
that exact schema (no public-schema fallback), no foreign users, and full policy
columns plus migration readiness. Missing/partial storage closes the connection
and rejects startup before Fastify/worker startup. C1 rollback and adaptive fallback
both retain PolicyQueueService and the same D fence; no legacy queue bypass exists.

Pilot runtime internally disables importer recovery, installs the top-level HTTP
guard, and keeps primary OAuth allowlisted and playback denied. Without the
explicit mutation opt-in it also denies mutation reads/writes and advertises
`spotifyWrite:false`. Legitimate review, feedback and
policy workers remain enabled. No audio/provider worker is constructed. Existing
unguarded `spotifyHttp`, `spotifyMutationFetch` and `playbackTransport` options are
rejected in pilot mode. For synthetic tests, optional `pilot.oauthFetch` remains
wrapped by the OAuth allowlist, and `pilot.mlFetch` is injected into the validated
loopback ML clients.

Only pilot mode returns `runtime.pilot = {repository, ml, policyStore}` for private
operator bootstrap and verification. These server ports are not HTTP routes;
manual fit remains forbidden in the browser. Default runtime behavior is unchanged.
Combined tests exercise real disposable PostgreSQL schemas and synthetic transports
for C1, LinUCB, epsilon-greedy and C1 fallback, including OAuth, publication, KEEP,
SKIP, replay and Undo. This does not claim a live Spotify or real classifier run.

Runtime branch verification: general suite985passed/178skipped/0failed (5269assertions); focused disposable PostgreSQL runtime suite5passed/0failed (257assertions). Typecheck, web/API build and diff check passed. Independent read-only review found no actionable issues. No real account, provider calls, production copy, service launch or deployment was performed.

## Explicit Spotify mutation opt-in

`ReviewExclusionManifest.allowSpotifyMutations: true` requires its own approved
manifest digest. Omitting it or setting it to false retains the default guard.
A valid true manifest enables the existing ARCHIVE/UNLIKE workflow and Undo only
for exact pilot-published exposures; owner, exclusion, CSRF, idempotency and
durable worker fences still apply. It does not reinterpret historical SKIPs,
create labels, or authorize automatic actions on a newly served song.

Runtime enables the existing write capability only in this mode, and the public
capability additionally requires all actual Spotify write grants. Missing grants
retain the normal reconnect error. A separate mutation/reconciliation transport
uses the existing Spotify mutation adapter and current endpoints; the primary
OAuth client stays restricted to token/profile requests. Optional
`pilot.mutationFetch` supports authored provider tests and is rejected before any
database connection without the true manifest flag. Import, playback, ordinary
calibration labeling/batches, and public retrain remain disabled. Production C1 configuration is unchanged.

Remove remains label 1 and Keep label 0 under the existing shared contract. Skip
remains unlabeled. No live provider mutation or account training is established
by these HTTP/transport tests; combined disposable DB/ML acceptance is separate.

## Explicit post-Skip preference confirmation

`POST /api/calibration/corrections` accepts only
`{decisionId, label: 1, idempotencyKey}`. It confirms a Remove **preference** for
one previously skipped track. It neither removes a Spotify save nor changes the
original Skip, its Undo state, or its C2 association/reward. Normal four-action
review remains the separate route for Spotify changes.

The owner-locked transaction resolves identical retries first, then requires the
owner's latest current COMPLETE, unlabeled Spotify Skip, playable saved/deferred
membership, no pending mutation/Undo or known live policy reservation, no active
feedback, no historical holdout assignment (including revoked feedback), and no
batch reservation of any group/status. A pilot additionally requires an allowed
track and exact persisted original publication. A new command deliberately has
`split: train`; this explicit post-collection assignment must not enter an
independent evaluation set.

A new `purpose=calibration` exposure preserves the original frozen feature vector
(including missingness and training permission), prediction, and listening context.
Its provenance uses `post-collection:skip-correction:v1`, deterministic baseline,
zero exploration, null propensity, and no adaptive policy telemetry. The label's
stored request includes the exact `originalCorrectionRequest`; the original review
exposure is untouched. Revision and normal feedback outbox commit atomically with
the new exposure and label. No new migration, policy event, or provider transport
is involved. Actual C1 fitting and acknowledgement remain asynchronous.

Pilot HTTP guards allow only this preference write, calibration history, and
calibration Undo; ordinary calibration queue/label/batch routes remain denied.
The fenced DB store filters history and rejects Undo for inherited ordinary
calibration labels. Only correction provenance bound to an allowed, published
original Skip is accessible. Undo revokes the correction through the existing
unified-feedback and outbox path. A lost response must be retried with the same
original command/key; its returned exposure ID is generated by the server and is
not the original review exposure ID.

Authored disposable PostgreSQL tests cover full frozen evidence, missingness,
publication/exclusion checks, every reserved assignment, held-out tombstones,
mutation/reservation conflicts, concurrent correction, transaction rollback,
response-loss retry, and HTTP history/Undo isolation. They compare original review,
policy, library, work, and Spotify mutation rows before and after confirmation and
Undo. These checks do not establish any live account action or model fit.
