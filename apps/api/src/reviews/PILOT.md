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
5. Give Spotify mutation reads and writes `denyPilotProviderFetch`; it returns a
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
requires Spotify mode. POST logout retains normal CSRF checks. Only KEEP/SKIP
and Undo of a pilot-published KEEP/SKIP decision can reach review handlers.
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
guard, separates allowlisted primary OAuth from denied mutation reads/writes and
playback, and advertises `spotifyWrite:false`. Legitimate review, feedback and
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
