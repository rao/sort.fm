# B2: refresh the queue after a confirmed manual fit

Branch: `b2-retrain-queue-refresh`  
Approved base: `d4bb8b3294b76e3ecac441b9e98ccd60e3cd21ef`  
Worktree: `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-b2`

A successful manual retrain previously updated model metrics while leaving the loaded queue unchanged. The store now fetches and applies a fresh live snapshot after validating the FitResponse, while retaining the retraining lock through reconciliation. The server's order, prediction objects and fresh exposure IDs replace the loaded queue intact. Previously served objects are not mutated or relabeled.

If the required snapshot read fails, the confirmed fit metrics and existing queue remain. The UI reports “Your model was confirmed. Refresh the queue before continuing” through the existing refresh-error affordance. Review and another fit stay blocked until GET-only refresh succeeds; the fit POST is never automatically replayed. If only optional insights fail, the fresh queue is applied, the last confirmed fit metrics remain, and the existing insights warning remains visible. A later successful metrics read can supersede the fit response.

Session ownership, returned account/model/count validation, pending command journals and original retry exposure/idempotency keys remain unchanged. Ambiguous fit failures still require a model refresh before another fit. No polling or queue-triggered training was introduced. Automatic feedback may affect ordering on the next action/refresh if its model update finishes after the immediate snapshot; this is the agreed P0 behavior.

## Changed files

- `apps/web/src/state/review.ts`: fourteen lines adding post-fit reconciliation and separate read-failure handling.
- `apps/web/src/state/retrain.test.ts`: controlled HTTP tests for reversed server order, fresh exposures, unchanged previously served objects, lock duration, duplicate prevention, required-read failure/recovery, owner change, optional insights failure, and preservation of pending commands. Existing identity and ambiguous-fit tests remain.
- This handoff.

No contracts, APIs, dependencies, styling, components, Python, or shared-root files changed.

## Verification

- Focused retrain suite: **13 passed / 67 assertions**.
- All frontend tests: **77 passed / 303 assertions**.
- Root TypeScript/Bun tests: **439 passed / 2,305 assertions / 67 opt-in skips**.
- Root typecheck, frontend lint, web/API production build and `git diff --check`: passed.
- Foundation HTTP smoke: passed with local socket permission after the sandbox prevented its initial server bind. No test changes were made to resolve that environment restriction.
- Independent review: no actionable findings; reviewer additionally ran 48 relevant lifecycle tests successfully.
- Existing two Zod PURE-comment build warnings remain nonfatal.

These are controlled HTTP/store tests, not verification of live Spotify actions, real-account manual retraining, or A1's concurrent adaptive ranking implementation. Browser visuals, Tiger/C1 integration, and Python suites were not rerun for this store-only correction. No user data or secrets are included.

## Integration

Review/cherry-pick the published branch onto canonical after A1's queue work. There are no migrations or install changes. Verify manual retrain followed by a newly ordered queue against A1's server implementation; the frontend uses the existing `balanced` policy and limit 20. Preserve every new response's immutable exposure/prediction pairing. On an injected follow-up queue failure, verify the fit remains confirmed and Refresh queue issues only reads before review resumes.

No merge, deployment, C2 work, or playback change was performed. Playback remains subject to its existing backend/SDK gates. The final chat handoff supplies the exact published commit hash.
