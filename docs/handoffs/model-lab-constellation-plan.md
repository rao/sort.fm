# Taste Constellation implementation plan

Spec: user's attached Taste Constellation brief, 2026-11-08. Base: c210eb3.
Branch: feat/model-lab-constellation. Worktree: sort.fm-model-lab.

Goal: Add an honest, responsive acoustic map to Model Lab, preserve the four
existing tabs, and explain model/evaluation/policy evidence clearly.

Architecture: isolated React/TypeScript components in
`apps/web/src/components/taste-constellation/`. A deterministic PCA and exact
sparse nearest-neighbor builder runs in a Web Worker. Canvas 2D draws only on
interaction; no physics or continuous animation. Reuse BoardUI buttons/search,
semantic tokens and existing Model Lab framing. No dependency changes needed.

Constraints: no shared contract, backend, classifier, policy, database, shell,
calibration, review journal or playback edits. No real library exports/artifacts
in source, logs or screenshots. No deployment or independent merge.

## Tasks
- [x] Data/math: strict local presentation adapter, fail closed on unsanitized
  data; deterministic synthetic fixtures; observed-feature scaling, PCA, sparse
  overlap-aware nearest neighbors, coverage. Test finite/zero/missing/constant
  descriptors, identical tracks, duplicate IDs, privacy and 2,700-node scale.
- [x] Constellation: worker lifecycle, selectable canvas, hover, search,
  keyboard navigation, zoom/pan/reset, detail panel, low-coverage states,
  reduced motion and explicit synthetic/live separation. Integrate fifth tab.
- [x] Explanations: model glossary, metric/evidence guide, stored-feedback
  paired chart, actual explore/exploit telemetry presentation.
- [x] Verify: root typecheck/tests/build, frontend lint, browser interactions,
  screenshots at desktop/mobile with synthetic data only. Independent final
  review, focused local commit(s), integration contract and handoff.

## Decisions / review focus
- No existing public API exposes library feature vectors or an evaluation-free
  identity roster. Do not reconstruct features from explanations or query
  calibration/research endpoints. Live map remains unavailable until integration
  supplies a server-filtered owner-only read. The adapter is a proposed local
  view contract, not a newly implemented endpoint.
- Input labels never affect geometry; only explicit labels affect node colors.
- Projection uses mean imputation after observed-value standardization;
  distances use shared observed values only, with a minimum overlap. Insufficient
  feature rows stay searchable but unplaced, with no invented geometry.
- Rank neighbors in feature space, not the distorted 2D map; no confidence or
  learned-edge claims. C1 score and timestamp must be supplied, never inferred.
- Browser work must cancel obsolete workers, handle failure, and never block
  other tabs; dense edges are suppressed by default.

## Progress
- Repository and boundaries inspected. Native worktree tool could not resolve
  the parent directory (not a repository); created the requested separate Git
  worktree from the verified canonical commit using git.
- Baseline typecheck passed. Baseline tests: 1045 pass / 204 skip / 3 socket-bind
  failures under the restricted execution environment; investigate with the
  verification run, without touching backend code.
- User clarified that the actual-library graph is the intended final behavior.
  Proposed the exact authenticated GET contract to the master overseer and A;
  the overseer approved and assigned endpoint/exclusion implementation to A/D.
  Real loading is the default. Demo requires an explicit choice and is never
  substituted after a failed or empty response. Shared contracts stay unchanged
  on this frontend branch; the endpoint implementation is integration-owned.
- Independent review found sparse-link toggles resetting the camera. Fixed and
  browser-verified at 140% zoom; also cleared keyboard tooltips on canvas blur.
- Final verification: 1,063 tests passed / 204 skipped / 0 failed; typecheck,
  frontend lint, production build, foundation smoke and diff whitespace passed.
  Socket tests pass when granted the local binding access they require.
- Browser verified 2,700 supplied / 2,674 placed tracks, search, correct details,
  nearest neighbors, hover, keyboard, pan, zoom, sparse links, empty/missing/error
  responses, explicit demo provenance, existing four tabs and 390px mobile.
- See `model-lab-constellation.md` for the complete contract, ownership, evidence,
  backend coordination and integration acceptance requirements.
