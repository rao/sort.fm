# B2 calibration-only frontend handoff

Implementation: `333b016` on `b2-calibration-labels`, based on approved foundation `e1a1229` plus frozen calibration contracts `981de79`. Worktree: `sort.fm-b2`. No merge to main/foundation, shared-contract edits, backend edits, or changes to root-owned `apps/web/vercel.json`.

## Delivered behavior

`#/calibrate` now uses a dedicated client, store, session journal, gestures and history. It cannot call `ReviewStore.decide`, cleanup Undo, or player mutations. The public client boundary exposes only session, calibration queue/label/Undo/history, insights and manual retrain methods.

- **Would keep** saves label 0; **Would remove** saves label 1. Both submit the exact served track/exposure and a fresh UUID idempotency key. Only a validated committed response or matched history result confirms success.
- **Skip** changes only the current browser session's selection. It sends no request and creates no feedback. Show skipped songs reloads the selection.
- Right/left arrows and horizontal swipes label; Up/upward swipe skips; Z undoes the latest eligible calibration label. Down has no action. Input/button/link/dialog focus and repeated/modifier keypresses do not trigger shortcuts.
- Label Undo targets calibration IDs only. Revoked and superseded labels are displayed as such and cannot be undone. Submitted labels stay distinct from effective active labels.
- The journal is owner-scoped under `sortfm:calibration:pending:v1:<owner>` in sessionStorage, separate from cleanup commands. Commands persist before sending. Ambiguous results lock new labels/fits and expose read-only outcome recovery or an explicit retry with the original key and payload. Reload never automatically repeats a write.
- Known first-attempt, nonretryable A1/D 409 eligibility rejections clear the unaccepted command and require a fresh GET before continuing. Unknown/idempotency conflicts and any previously ambiguous command retain their key. The allowlist is documented in `state/calibration.ts`; it is based on A1/D's pre-commit checks, not a blanket 4xx assumption.
- A confirmed label followed by a failed refresh requires GET recovery, not another label POST. Duplicate actions serialize. Session-owner changes and unavailable/malformed contracts fail closed.
- Cards show imported artwork/metadata/save dates but hide song predictions during labeling. Missing artwork uses B1's existing placeholder.
- Counts distinguish active labels in loaded history from server-confirmed model feedback across all sources. Model version, training and holdout counts come from insights/retrain results. Optional insights failures preserve prior confirmed metrics with an unavailable warning; nonempty synthetic metrics are excluded. Only the previously approved exact empty C1 evaluation exception is accepted.
- Manual retrain uses the existing public endpoint, validates owner/model/count identity, and refreshes calibration after confirmation. Failed fits require model refresh before another fit.
- The UI explicitly distinguishes online library sampling from C1's offline sealed evaluation cohort. It does not select splits, inject offline models, or claim evaluation equivalence.
- Review keyboard listeners, cleanup recovery/Undo toasts, and the review player footer are excluded from the calibration route. Existing review functionality is otherwise preserved. Connected import completion links to calibration; demo calibration is explicitly unavailable, with a separate demo review link.

## Changed files

| Files under `apps/web/` | Purpose |
| --- | --- |
| `src/data/calibration-client.ts` | Restricted API boundary, owner checks, separate validated journal, truthful metrics |
| `src/state/calibration.ts` | Labels, local Skip, Undo, recovery, refresh, manual retrain and action locking |
| `src/components/Calibration.tsx` | Preference cards, gestures, history, model counts and recovery surfaces |
| `src/App.tsx` | Route/store isolation and navigation |
| `src/components/Connected.tsx`, `src/components/Library.tsx` | Connected calibration entry and demo separation |
| `src/styles.css` | B1-compatible calibration layout and responsive history |
| `src/state/calibration.test.ts`, `src/components/calibration.test.tsx` | State, recovery, safety boundary and rendering regressions |
| `src/test-support/calibration-fixture.ts` | Explicit controlled API fixture; unknown/cleanup routes rejected |
| `scripts/calibration-preview.ts` | Loopback-only browser QA server requiring an explicit fixture flag |
| `docs/screenshots/b2-calibration-*-fixture.png` | Desktop/mobile fixture proof, visibly marked as test data |
| `docs/B2-calibration-handoff.md` | This integration handoff |

## Verification

On this branch:

- `bun run typecheck` — passed.
- `cd apps/web && bun run lint` — passed, 33 source files.
- `bun run build` — passed web and API production builds. Vite reports the two existing Zod PURE annotation warnings.
- `bun test` — **545 passed, 68 skipped, 0 failed; 2,856 assertions across 53 files**. Local HTTP listener tests require execution outside the filesystem/network sandbox. The database/live-service gated tests remain skipped; they are not counted as verified integration.
- Calibration-focused suite — **18 passed, 85 assertions**. The stale-exposure regression failed before the fix and passed afterward. A separate reviewer found no remaining blockers in the fix.
- `bun run smoke` — passed foundation HTTP smoke with no Spotify calls; also requires local socket access.
- `git diff --check` — passed before commit.
- Fixture preview script bundles successfully for Bun.

Browser checks against the production web bundle and controlled local API verified: both binary labels, local skip/show skipped, actual left swipe, ignored Down, Z label Undo, manual fit with returned counts, lost response locking, reload recovery, and unavailable-service failure/recovery. Desktop and 390px mobile layouts were inspected; no horizontal overflow and no captured console warnings/errors. These are mocked API checks, not proof of the integrated live calibration backend.

To reproduce the isolated browser QA, from the repository root:

```sh
bun run build
SORTFM_TEST_FIXTURE=1 bun apps/web/scripts/calibration-preview.ts
```

Open `http://127.0.0.1:5196/#/calibrate`. The fixed fixture banner provides disposable reset, response-loss, service/queue/fit failure and recovery controls. No credentials are loaded and no Spotify/ML requests are sent. Do not deploy this script or mistake its fake session/metrics for personal data.

## Integration gates and limitations

1. Merge after `981de79`; integrate D's migration/persistence and A1's calibration registrar, then let root register them in the live runtime. Apply the migration before enabling routes. The frontend intentionally remains unavailable against unimplemented routes.
2. Integration must verify calibration label/Undo and replay through real owner-scoped DB transactions, durable feedback delivery and real C1. Confirm zero Spotify transport calls, unchanged membership/status, wrong-purpose exposure rejection, one revision/effective example, immutable splits, and cleanup supersession behavior. Those are backend-owned guarantees, not claims established by the UI fixture.
3. Collect labels from the human owner, then use **Retrain from saved feedback** and inspect the actual model counts/version. This work did not create personal calibration labels, touch the live model, make Spotify mutations, or establish learned accuracy.
4. Calibration history currently returns IDs rather than track metadata. Previously seen tracks retain metadata in memory; after refresh, older history uses a truthful track ID and Spotify link. No invented titles or additional cleanup fetches.
5. The frozen history client accepts no cursor although the response has `nextCursor`. The UI says **Recent labels only** when truncated and labels counts as loaded-history counts. It can recover absent older outcomes via explicit original-key replay. If the backend starts paging, propose a cursor or owner-scoped command lookup before claiming complete historical browsing. No silent contract change was made.
6. A previously ambiguous command whose original outcome cannot be found remains blocked even if a later retry reports an eligibility conflict. Do not discard it automatically: an earlier request may have committed. If this becomes an operational case, provide an authoritative owner-scoped command outcome/reconciliation endpoint; do not infer success/failure from current eligibility.
7. Browser sessionStorage survives reload in the same tab, not deliberate tab/session destruction. Server history and backend idempotency remain authoritative. This matches the existing frontend journal scope.
8. Production OAuth/cookies/CORS, live integrated calibration, SDK token policy and deployment cutover remain integration-lead responsibilities. This change neither exposes credentials nor alters the existing backend-driven playback implementation.

Screenshots are fixture-only: `screenshots/b2-calibration-desktop-fixture.png` and `screenshots/b2-calibration-mobile-fixture.png`.
