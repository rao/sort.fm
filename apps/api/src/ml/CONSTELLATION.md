# Read-only Taste Constellation API

`createTasteConstellationModule` registers authenticated GET
`/api/ml/constellation`. It accepts no query or body. Responses and handled errors
use `Cache-Control: no-store`; identity comes exclusively from the stored session.
No provider credential refresh is needed to read the projection.
Existing authentication may delete an expired session as housekeeping; this does
not write library, feedback, model or exposure state.

The module takes the existing `config` and `auth` route dependencies plus
`projection: ConstellationReadPort | null`. Register its `registerRoutes` through
`buildApp.registerRoutes` alongside the other modules. Integration owns runtime
composition with D's `PostgresConstellationStore`; this branch does not instantiate
that adapter or enable the route in the production runtime. A null projection or
any unprovable/malformed snapshot returns retryable 503 `CONSTELLATION_UNAVAILABLE`.

D's port is `constellation(userId) -> {userId, tracks}` using the exported
`ConstellationProjection` type. D must exclude permanent evaluation and monitoring
identities and pending work before selecting at most 5,000 tracks. Only effective
explicit eligible training labels become keep/remove. Unlabelled remains null;
audio contains observed cached values or missing values. D owns clipping display
metadata and accepting HTTPS image URLs. Missing or inconsistent privacy
infrastructure must fail closed. Neither a response marker nor schema validation
proves these persistence guarantees.

A validates the complete strict projection and owner before serialization, refuses
duplicate/non-Spotify identities or more than 5,000 tracks, and returns no internal
owner, exclusion lists/counts, revisions or outcomes. It adds a fresh `generatedAt`,
`mode: live`, `modelVersion: null` and `prediction: null` for every track. Zero is
preserved as an observed value; omitted/null features stay missing. No cache,
sampling, imputation or invented model scores are used.

The reusable `TasteConstellationSchema` exactly matches the graph's approved
live/synthetic shape. `PUBLIC_ROUTES.constellation.response` instead uses
`TasteConstellationLiveSchema`, so the HTTP contract rejects synthetic responses.
No existing DTO changes. The integration lead regenerates schema artifacts and
owns frontend adoption of shared exports.

Each authentication and projection read is bounded to two seconds by default
(`readTimeoutMs`, positive integer up to 15,000). The adapter remains responsible
for actual database cancellation/deadlines; late promise rejection is observed.
A timeout never falls back to unfiltered library data or synthetic tracks.

This module receives no scoring, training, queue, exposure, write or provider
capability. It does not modify pilot allowlists: the existing isolated C2 pilot
continues to deny this new route unless integration explicitly revises its scope.

Verification: 8 focused tests / 173 assertions cover real stored sessions for two
owners, expired provider credentials without refresh, revoked session rejection,
strict requests/DTOs, cross-owner snapshots, missing/privacy dependency failures,
read/auth timeouts, empty/maximum libraries, duplicate/oversized/synthetic data,
observed zero/missing values, no cache and capability isolation. Full suite:
1,056 passed, 204 environment-gated skips, 0 failed, 5,842 assertions. Typecheck
and web/API production build passed. Existing build warnings concern third-party
Zod annotations and bundle size.
Independent review found no actionable issues in the module or shared contract.

Remaining integration gates: D's actual privacy projection and forbidden-row
noninterference tests, root runtime composition/generated schema export, and
combined frontend/backend acceptance. No live account, database or provider calls,
deployment or canonical merge occurred in this workstream.
