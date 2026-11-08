# Isolated review pilot integration

These server-only helpers are opt-in. Default application behavior is unchanged.
There is no new public DTO or runtime configuration in this change.

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
