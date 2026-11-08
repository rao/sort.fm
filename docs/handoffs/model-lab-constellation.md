# Model Lab / Taste Constellation handoff

Date: 2026-11-08. Branch: `feat/model-lab-constellation`.
Base: `c210eb332207686c2e4384e65a45db8c52597134`.
Worktree: `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-model-lab`.

The frontend is complete against the agreed authenticated, read-only graph
contract. It requests the actual library by default. Synthetic data is an
explicitly selected, prominently marked demo; errors and empty results never
substitute it. No actual Spotify account or production graph was accessed for
this verification. Real-library acceptance remains with the master overseer
after composing and verifying the separately owned backend changes.

The native worktree helper initially failed because the chat's working directory
is the non-repository parent. Verified the canonical repository and created this
isolated Git worktree from the agreed base. No main-worktree edits, merges,
deployment, dependency updates or shared-schema changes were made.

## Files and ownership

- `apps/web/src/components/ModelLab.tsx`: additive fifth tab, lazy feature import,
  guide, paired feedback chart, actual C2 selection details and strategy badges.
- `apps/web/src/components/taste-constellation/data.ts`, `client.ts`, `audio.ts`:
  strict local contract mirror, readonly loader, deterministic invented fixture,
  descriptor formatting. Shared DTO adoption can happen during integration.
- `graph.ts`, `graph.worker.ts`: normalized acoustic neighbors and deterministic
  PCA in a cancellable worker. Only eligible supplied IDs/audio enter the worker.
- `ConstellationCanvas.tsx`, `TasteConstellation.tsx`, `constellation.css`:
  canvas rendering, zoom/pan/search/keyboard, reduced motion, selectable acoustic
  neighbors, coverage, missing-data states, responsive details and provenance.
- `LabExplanations.tsx`, `explanations.css`: E1–E3/C1/C2 glossary, metrics and
  evidence guide, supplied frozen-feedback comparison, actual policy telemetry.
- `graph.test.ts`, `client.test.ts`, `presentation.test.tsx`: contract, math,
  loading, feature coverage and truthful presentation tests.
- This handoff, the implementation plan and synthetic screenshots only.

No auth, Spotify writes, training, model/policy algorithms, Batch 3 infrastructure,
DB, playback, global shell/style or existing evidence adapter was changed.

## Exact endpoint contract

`GET /api/ml/constellation`, no query parameters or request body. Use the existing
owner session, credentials included and the existing `VITE_API_ORIGIN` override.
Return `Cache-Control: no-store`. Never fetch providers, train/score a model,
create exposures/reservations or mutate feedback while serving this read.

```ts
type Audio = {
  energy?: number | null;
  danceability?: number | null;
  happiness?: number | null;
  acousticness?: number | null;
  instrumentalness?: number | null;
  liveness?: number | null;
  speechiness?: number | null;
  tempo_bpm?: number | null;
  loudness_db?: number | null;
};
type Prediction = {
  modelVersion: string;
  scoredAt: string;
  removalProbability: number;
  calibrated: boolean;
  explanations: Array<{
    feature: string;
    contribution: number | null;
    description: string;
  }>;
};
type ConstellationResponse = {
  schema: "sortfm.constellation.v1";
  mode: "live";
  privacy: "evaluation-excluded";
  generatedAt: string;
  modelVersion: string | null;
  tracks: Array<{
    id: string;
    title: string;
    artist: string;
    imageUrl: string | null;
    label: "keep" | "remove" | null;
    audio: Audio;
    prediction: Prediction | null;
  }>;
};
```

Validation is strict at every object level. Bounds:

- At most 5,000 unique tracks; live IDs are 22 alphanumeric Spotify characters.
- Title: 1–200 characters; artist: 1–300; artwork: HTTPS or null.
- Seven unit descriptors: finite [0,1]; tempo: finite (0,400] BPM; loudness:
  finite [-100,10] dB. Missing/null stays missing. Observed zero is preserved.
- Timestamps: ISO datetimes with offsets accepted; versions: 1–128 characters.
- Removal probability: finite [0,1]. At most 50 explanation terms; feature:
  1–100 characters; contribution: finite or null; description: at most 600.
- Numeric explanation signs must use the supplied Remove-oriented convention:
  positive pushes toward Remove, negative toward Keep. Never synthesize terms.
- `modelVersion` identifies the current version at response time. A score is
  called current only if its version matches; otherwise it is clearly a stored
  prediction. Null scores/versions are supported and are the initial backend
  behavior. There is no frontend on-demand scoring.

Synthetic mode exists only in the local demo adapter. Its IDs must match
`demo:constellation:<digits>`; artwork, scores and model version must be null.
The live network loader rejects synthetic mode, duplicate IDs, unknown fields,
invalid ranges and missing/invalid provenance without logging payload contents.

401/403 gives a connection state; 404/501/503 gives an explicit unavailable
state; other failures give a generic retry state. Fetch/worker cancellation,
timeouts, retry, empty-library and missing-audio states are implemented. A failed
response body is never surfaced. No fallback calls target queue, calibration,
research or private model artifacts.

## Server privacy requirements and coordination

Before serialization, independently exclude sealed evaluation identities,
original monitoring holdouts, reserved Batch 3 identities and every permanently
excluded or currently reserved/pending evaluation identity. Apply this to both
nodes and labels. No excluded title, artist, audio, label, count, roster or ID
may enter the response, neighbors, screenshots, logs or tooltip paths. Read the
authoritative exclusion repository and fail closed if it is unavailable.

Labels must come only from eligible effective explicit training Keep/Remove
feedback. Never reinterpret library membership as Keep, Skip as Remove, undone
feedback as active, or evaluation labels as training feedback. Preserve eligible
training-labeled library tracks even if review queues omit already reviewed
tracks. Do not blindly reuse queue eligibility. The frontend has no exclusion
roster and cannot enforce an unknown server-side boundary: the privacy literal
is a contract declaration, not proof of filtering.

The exact contract was sent immediately to master chat
`01a1b753-b9c8-7941-a258-ca9ffdf69301` and coordinated with A. The master approved
and assigned the backend/exclusions to A/D. Reported integration commits:

- A: `7c2510177300e83c12af4086962ce88102fe4882`, worktree
  `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-a1-constellation`.
- D: `af88c4a`, worktree
  `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-d-taste-constellation`.

A reported shared schemas `TasteConstellationSchema`,
`TasteConstellationLiveSchema`, `TasteConstellationTrackSchema`,
`TasteConstellationAudioSchema`, `TasteConstellationPredictionSchema`, plus
`PUBLIC_ROUTES.constellation`, matching this mirror. The master owns their
privacy review, integration order, real-data validation and any deployment.

## Geometry and interpretation

Descriptors are standardized using observed values from the eligible response.
Constant or insufficiently observed columns are discarded. Rows require at
least `max(3, ceil(activeDescriptorCount / 2))` observed active descriptors.
Missing values are mean-imputed only for the reproducible covariance PCA
projection; placed rows are recentered before projection. ID ordering, a
deterministic Jacobi eigensolver and fixed eigenvector signs make identical input
reproducible. Fewer than three eligible rows or zero variance yields no invented
positions or edges. Changing eligible library membership may change the PCA.

For neighbors, use RMS distance over jointly observed standardized descriptors,
with the same minimum overlap. Missing values never become zero-distance
observations. Show up to six nearest acoustic neighbors with overlap counts and
distances. Optional background links retain only mutual top-three neighbors.
No labels, model scores or 2D proximity enter the distance calculation. All
labels and C1 scores are separate supplied presentation fields. Similarity is
descriptive and is not a learned preference or calibrated probability.

Projection can distort distances, and partial-overlap distances are imperfectly
comparable despite their RMS normalization. The UI discloses both the projection
variance and overlap rule. No centroids are drawn because no public sanitized
centroid contract was supplied. No invented neural connections or confidence.

Method references: [PCA](https://scikit-learn.org/stable/modules/generated/sklearn.decomposition.PCA.html)
and [overlap-aware distances](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.pairwise.nan_euclidean_distances.html).
Our neighbor distance is RMS over overlap, rather than the total-dimensional
Euclidean magnitude described by the second reference.

## Verification

Final checks on the frontend branch:

- `bun run typecheck`: pass.
- `bun test`: **1,063 pass, 204 skip, 0 fail**, 5,737 assertions; 1,267 tests
  across 132 files. Existing local HTTP tests require socket access. Restricted
  baseline socket failures disappear with that access; no backend fixes needed.
- `bun run lint` in `apps/web`: pass, 95 files.
- `bun run build`: pass, frontend and API. Graph worker 3.22 kB; feature JS
  69.76 kB / 24.55 kB gzip, lazy-loaded. Existing main chunk warning remains
  (570.38 kB); upstream Zod annotation warnings are non-fatal.
- `bun run smoke`: pass; local foundation HTTP smoke, no Spotify calls.
- `git diff --check`: pass.
- Independent review: one camera reset issue found and fixed; sparse-links
  toggling preserves the zoom/pan. Reviewer also checked eigensolver residuals
  on 100 random positive semidefinite matrices, below 1e-10.

Browser verification used invented data only. A temporary local QA harness
exercised the actual connected-loader path with authored live-shaped responses;
it has been removed from the worktree. Verified 2,700 supplied / 2,674 placed
tracks, 26 unplaced missing-audio rows, nine descriptors and 63.0% PCA variance.
Search, click/keyboard selection, properties, neighbors, hover/blur, pan, zoom,
reset and sparse links worked. Verified unavailable, invalid-privacy, empty and
all-missing response states. Existing four tabs remained functional in their
honest demo/awaiting-evidence states. No browser error/warning logs observed.
390px mobile has no horizontal overflow and stacks the detail panel below the
map. Reduced-motion logic and keyboard paths are implemented; no screen-reader
or cross-browser audit is claimed.

## Screenshots — synthetic data only

- [Desktop overview](constellation-screenshots/desktop-overview.jpg)
- [Desktop selected track and neighbors](constellation-screenshots/desktop-selection.jpg)
- [Mobile overview](constellation-screenshots/mobile-overview.jpg)
- [Mobile selected track](constellation-screenshots/mobile-selection.jpg)

## Remaining integration acceptance

Compose the A/D endpoint with this branch, confirm the shared schema matches
exactly, and validate an authenticated actual-library response. Verify excluded
identities are absent at the backend serialization boundary and absent from
explicit labels, returned tracks, neighbors and tooltips. Exercise missing
exclusion storage, missing cached audio and auth failures without provider or
ML side effects. Never log response payloads during that check.

The initial endpoint intentionally supplies null C1 scores/version. The UI
supports genuine stored scores and explanations when supplied; acoustic graph
availability does not depend on scores. Exact neighbor construction is O(n²d),
worker-isolated and bounded to 5,000 inputs; verified at approximately 2,700,
not benchmarked across all mobile hardware. No production acceptance, merge or
deployment is claimed by this frontend handoff.
