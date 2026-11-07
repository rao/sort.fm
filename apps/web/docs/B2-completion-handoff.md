# B2 frontend integration handoff — completion pass

Implementation commit: **`9fb3147334b2f5bbd87a5bc79d2928b86b5d742f`**  
Branch: **`b2-playback-inspector`**  
Worktree: `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-b2`  
Approved base: `d6d55b4` on canonical `foundation`. No merge to main or foundation was performed. All tracked changes are under `apps/web/**`; shared schemas, backend, ML, database, dependencies and root lock are unchanged.

This pass extends the accepted B1/B2 P0 implementation already in the base. Its original behavior and limitations are recorded in [B2-handoff.md](B2-handoff.md). **This is a verified frontend handoff, not a claim that live Spotify playback, production deployment or every B2 acceptance gate is complete.**

## Delivered behavior

- Existing live authentication, import polling, imported artwork/metadata, four gestures, persisted decision history, server-ID Undo and tab-scoped retry journals remain intact. Demo remains an explicit isolated entry point.
- Validated, credentialed calls to the frozen `GET /api/player/status`, `POST /api/player/play` and `POST /api/ml/retrain` routes. Play bodies use `PlayRequestSchema`; responses use the registry schemas. POSTs never retry automatically.
- The existing player footer now offers playback when the session advertises the capability. A click checks current account ownership, capability and device availability before sending a backend command. No browser code calls a Spotify mutation endpoint or receives provider credentials.
- Playback success is displayed only when a subsequent status response reports the requested URI playing. Accepted-but-unconfirmed playback, no device, provider failure, unavailable tracks and unavailable capability have distinct states. Repeated clicks serialize; unmount cancels pending preparation; polling only reads status and pauses while the page is hidden. Navigation and swipes never start audio. Open in Spotify remains visible on desktop and mobile.
- Retraining is an explicit action, serialized with review, undo, retry and refresh. Returned account, model version and training count must agree before updating metrics. Errors preserve the last confirmed model and block another fit until model data is reconciled; refresh clears the recovery alert only when non-quarantined model metrics are returned. History disables Undo and explains the wait during training.
- Inspector displays supplied balanced accuracy, ROC-AUC, PR-AUC, log loss, Brier score, precision at k, removal base rate, evaluation timestamp, holdout class mix, audio enrichment failures and per-feature completeness. Nulls render as unavailable/not supplied. Zero missingness correctly renders 100% present.
- Current-song predictions show their immutable exposure model/version/sample count, uncertainty and supplied explanations/contributions. Heuristic scores are explicitly distinguished from probabilities. A new fit does not relabel old song scores with the latest model version.
- Synthetic trained/computed metrics returned in a live response are isolated as unavailable with a warning; independent audio status remains visible. C1’s exact zero-label, no-evaluation response is retained unchanged despite its frozen-enum `synthetic` fallback and shown as “No feedback yet.”
- Footer height is measured so mobile notifications stay above playback controls. B1 typography, artwork treatment, animation and card interactions remain.

## Changed files

| Files under `apps/web/` | Purpose |
| --- | --- |
| `src/App.tsx`, `src/styles.css` | Mount controls, serialize action affordances, responsive footer/notification spacing |
| `src/components/PlaybackControls.tsx`, `src/state/player.ts` | Capability/account/device checks, request and confirmed playback states, read-only polling |
| `src/components/Insights.tsx`, `src/components/ModelPanel.tsx` | Real model details, evaluation, feature completeness, exposure provenance, retraining controls |
| `src/components/History.tsx` | Disable and explain Undo while fitting |
| `src/data/live-client.ts`, `src/state/review.ts` | Registry-backed methods, model-result validation, retrain state, synthetic metric isolation |
| `src/data/controls.test.ts`, `src/data/live-client.test.ts` | HTTP contract, retry, provenance and non-destructive Undo regressions |
| `src/state/player.test.ts`, `src/state/retrain.test.ts`, `src/components/inspector.test.tsx` | Playback races/errors, model lifecycle and truthful rendering |
| `src/test-support/live-fixture.ts`, `scripts/fixture-preview.ts` | Controlled test-only playback/training failures; valid Keep/Skip Undo; configurable loopback port |
| `docs/B2-completion-plan.md`, this handoff, `docs/screenshots/b2-*-fixture.png` | Scope, proposed contract changes and labeled browser evidence |

## Verification performed

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed; no tracked dependency changes |
| `bun run typecheck` | Passed |
| `bun run --filter @sortfm/web lint` | Passed, 27 source files |
| `bun run --filter @sortfm/web test` | **64 passed, 225 assertions, 0 failures** |
| Root `bun test` | **285 passed, 56 skipped, 1,429 assertions, 0 failures** |
| `bun run build` | Web and API builds passed; two pre-existing nonfatal Zod PURE-comment warnings |
| `bun run smoke` | Passed isolated HTTP foundation smoke |
| `bun --env-file=../sort.fm/.env scripts/smoke-backend.ts` | **1 passed, 125 assertions** against actual Tiger + real temporary C1, controlled Spotify transport, disposable schema/artifacts |
| `git diff --check` | Passed |
| Independent code review | Two UX findings fixed and regression-tested; final review found no remaining P1/P2 issues |

Default tests skip opt-in database/provider suites; the dedicated backend smoke above was run separately. The first sandbox-only baseline failed three local socket tests; all passed unchanged with socket permission. The first integrated smoke timed out waiting for a fresh isolated ML runtime. A direct `uv run --locked --directory services/ml python -c 'import uvicorn; import sortfm_ml.app'` succeeded, and the same unmodified smoke then passed. No backend timeout or test was weakened.

The integrated smoke verifies controlled OAuth, encrypted session persistence, import, actual DB records and scored exposures, all four decisions, repeated requests, archive-before-unlike, Undo, membership restoration, automatic feedback/model reconciliation and ML-outage fallback. It does **not** make real Spotify calls or prove real audio playback. Python service source is unchanged; its entire Python suite was not rerun in this frontend pass.

### Browser evidence

Used the production Vite bundle served by the permanently labeled loopback fixture, plus a separate isolated Vite frontend against the running local API:

- Import idle → running → complete, then queue entry.
- Actual arrow-key Keep, Archive, Skip and Unlike, with confirmed Undo. Initial browser testing caught an invalid fixture Keep/Skip Undo step; fixed it to the authoritative `NONE` and added regressions.
- Failed Unlike leaves the same card, reload restores its pending command, explicit retry settles it, persisted History Undo restores by server decision ID even when metadata was initially absent.
- Device unavailable → explicit recovery → confirmed playback; playback failure leaves review usable and Open in Spotify visible. Unplayable cards show an unavailable explanation.
- Retraining visibly changes model version and label/training/holdout counts while preserving the exposure-time version. Failed training preserves the old model; successful refresh clears the alert.
- Desktop 1440×900 and mobile 390×844 inspected. Mobile document width did not exceed viewport; measured notification bottom stayed above footer top. Latest inspected page had no console warnings/errors.
- Actual local API returned an anonymous browser session. The public no-login demo loaded and remained visibly labeled. No live-owner consent or real-user mutations were attempted.

Evidence is synthetic HTTP testing, not a live-account claim:

- [Desktop inspector](screenshots/b2-inspector-fixture.png)
- [Mobile inspector](screenshots/b2-inspector-mobile-fixture.png)
- [Mobile footer and notification](screenshots/b2-playback-mobile-fixture.png)

## Unresolved dependencies / proposed shared changes

1. **Native Web Playback SDK is blocked.** `docs/contracts.md` explicitly requires resolving SDK token handling before exposing tokens, while the user requires credentials remain private. The frozen routes have neither an SDK token endpoint nor a device transfer request; the base backend does not enable playback. This pass implements backend-controlled playback for an existing device and a complete unavailable fallback, **not native browser audio**. Spotify's [SDK reference](https://developer.spotify.com/documentation/web-playback-sdk/reference) requires a Premium access token callback and gesture-time `activateElement()`. The integration lead must approve a short-lived playback-token boundary and a validated, owner-scoped backend device-transfer contract before SDK initialization, token renewal and autoplay-error handling can be implemented. Never expose the OAuth client secret, refresh token, library-write credential or internal ML secret.
2. **Public model and player endpoints need backend implementation/wiring.** The frontend handles their explicit 501/authorization/unavailable states. This branch does not install these routes; their success paths were tested through validated HTTP fixtures. Verify real `/api/ml/insights` and `/api/ml/retrain` against persisted C1 versions after integration.
3. **No telemetry series or ablation DTO exists.** `analytics` only returns library and model aggregates. No time-series chart or fake ablation data was added. Lead-owned additions must include real buckets/timestamps, model versions, event counts, evaluation provenance and nullable results. Training class counts also require explicit fields; holdout class counts cannot stand in for training mix.
4. **React Query is not installed.** The inherited in-flight read deduplication and bounded retry remain. Adding React Query requires a coordinated root dependency/lock update; no undeclared dependency was introduced.
5. **History lacks track metadata/cursor input.** Existing track-ID/Spotify-link fallback and bounded-history notice remain. A richer DTO is a lead-owned change.
6. **Live-owner and production gates remain.** Owner OAuth/import, four real provider actions plus Undo on user-selected tracks, real Premium audio and SDK initialization, real retrained-model browser updates, deployed HTTPS/CORS/cookies and public deployment need separate verification. The anonymous local browser session could not verify these.

## Integration instructions

Review/cherry-pick implementation commit `9fb3147334b2f5bbd87a5bc79d2928b86b5d742f` onto the integration branch after reconciling concurrent frontend edits. This branch was based on accepted foundation, not an unmerged B1 sibling. There are no migrations or installation changes. This agent has not merged or deployed anything.

Reproduce the production fixture from the repository root:

```sh
bun install --frozen-lockfile
bun run build
SORTFM_TEST_FIXTURE=1 SORTFM_FIXTURE_PORT=5192 bun apps/web/scripts/fixture-preview.ts
```

Open `http://127.0.0.1:5192`. The fixture banner exposes decision/playback/training failures, missing device, recovery, session expiry and reset controls. It binds only loopback, never reads credentials and is outside the production bundle. Its `user_feedback`-shaped responses are controlled test data identified by the permanent HTTP-fixture banner. Close/reopen the test tab for a fresh session journal after resetting server fixtures; reset deliberately does not erase unrelated browser storage.

For live deployment keep `VITE_API_ORIGIN` configured to the approved API origin, or provide a same-origin `/api` proxy with credentialed CORS/cookie settings. Playback capability must remain false until the backend is installed. Use the current SDK/telemetry proposals above rather than inventing frontend-only endpoints or metrics.


## Pre-integration correction: cold-start audio and retrain recovery

The integration lead reported C1’s empty evaluation uses `dataset: synthetic` because the frozen dataset enum has no no-source value. Confirmed the behavior in `services/ml/src/sortfm_ml/evaluate.py`: an empty example set is `insufficient_data`, evaluation method `none`, all five counts zero, all seven metric values null, and no evaluation timestamp. The frontend now recognizes only this complete combination. It preserves the original DTO and model version, displays “No feedback yet,” and does not claim synthetic training or computed evaluation.

Other synthetic model responses remain quarantined, including nonzero example counts with unavailable evaluation and populated evaluation results. Quarantine now removes only model metrics/prediction from the frontend view; it retains validated `audioFeatures`. The inspector renders audio status, ready/total, failures, missingness, and provider reason even when model metrics are unavailable. There are no shared-contract, Python, backend or dependency changes.

Also resolved the independent review’s minor retrain recovery finding: the store and button require a successful model-data refresh after a failed/ambiguous fit before permitting another fit. An audio-only response cannot clear that recovery state. The same exact-empty exception applies to a successful retrain result; owner/version/count validation and rejection of nonempty synthetic fits remain intact. Independent follow-up review found no remaining issues after this consistency fix.

Changed files in this correction: `src/data/live-client.ts`, `src/state/review.ts`, `src/components/Insights.tsx`, their existing three test files, `src/test-support/live-fixture.ts`, and this handoff. Controlled tests reproduce a C1-shaped cold response plus 3/2768 audio rows, first Keep, Undo to zero labels, refresh, actual synthetic computed-metric quarantine, null-model audio rendering, and the retrain recovery gate. They contain no private user data.

Fresh verification after the correction: **72 frontend tests / 266 assertions**, **293 repository tests / 1,470 assertions / 56 opt-in skips**, typecheck, frontend lint, web/API production build, and `git diff --check` all passed. The two existing Zod annotation warnings remain nonfatal. The earlier browser and disposable Tiger/C1 smoke results above remain historical evidence; neither was rerun for this focused frontend correction. The lead’s separately reported live-account result was used to diagnose the response shape, not claimed as this branch’s own live verification.

Integrate the complete `b2-playback-inspector` branch, including this correction, rather than only its original implementation commit. Then verify the current canonical public model routes with the actual zero-feedback account before first decision and after Undo-to-empty. Canonical backend work may already resolve some route blockers listed above; this branch intentionally does not duplicate it. Native SDK token/transfer contracts remain a separate unresolved gate.
