# B2: refresh the queue after a confirmed manual fit

Branch: `b2-retrain-queue-refresh`  
Approved base: `d4bb8b3294b76e3ecac441b9e98ccd60e3cd21ef`  
Worktree: `/Users/ramin/Desktop/v2code/ubhacking2026/sort.fm-b2`

A successful manual retrain previously updated model metrics while leaving the loaded queue unchanged. The store now fetches and applies a fresh live snapshot after validating the FitResponse, while retaining the retraining lock through reconciliation. The server's order, prediction objects and fresh exposure IDs replace the loaded queue intact. Previously served objects are not mutated or relabeled.

If the required snapshot read fails, the confirmed fit metrics and existing queue remain. The UI reports “Your model was confirmed. Refresh the queue before continuing” through the existing refresh-error affordance. Review and another fit stay blocked until GET-only refresh succeeds; the fit POST is never automatically replayed. If only optional insights fail, the fresh queue is applied, the last confirmed fit metrics remain, and the existing insights warning remains visible. A later successful metrics read can supersede the fit response.

Session ownership, returned account/model/count validation, pending command journals and original retry exposure/idempotency keys remain unchanged. Ambiguous fit failures still require a model refresh before another fit. No polling or queue-triggered training was introduced. Automatic feedback may affect ordering on the next action/refresh if its model update finishes after the immediate snapshot; this is the agreed P0 behavior.

## Changed files

- `apps/web/src/state/review.ts`: post-fit reconciliation, separate read-failure handling, and same-owner metrics preservation during optional insights outages.
- `apps/web/src/state/retrain.test.ts`: controlled HTTP tests for reversed server order, fresh exposures, unchanged previously served objects, lock duration, duplicate prevention, required-read failure/recovery, owner change, optional insights failure, and preservation of pending commands. Existing identity and ambiguous-fit tests remain.
- This handoff.

No contracts, APIs, dependencies, styling, components, Python, or shared-root files changed.

## Verification

- Focused retrain suite: **17 passed / 95 assertions**.
- All frontend tests: **81 passed / 331 assertions**.
- Root TypeScript/Bun tests: **443 passed / 2,333 assertions / 67 opt-in skips**.
- Root typecheck, frontend lint, web/API production build and `git diff --check`: passed.
- Foundation HTTP smoke: passed with local socket permission after the sandbox prevented its initial server bind. No test changes were made to resolve that environment restriction.
- Independent review: no actionable findings; reviewer additionally ran 48 relevant lifecycle tests successfully.
- Existing two Zod PURE-comment build warnings remain nonfatal.

These are controlled HTTP/store tests, not verification of live Spotify actions, real-account manual retraining, or A1's concurrent adaptive ranking implementation. Browser visuals, Tiger/C1 integration, and Python suites were not rerun for this store-only correction. No user data or secrets are included.

## Integration

Review/cherry-pick the published branch onto canonical after A1's queue work. There are no migrations or install changes. Verify manual retrain followed by a newly ordered queue against A1's server implementation; the frontend uses the existing `balanced` policy and limit 20. Preserve every new response's immutable exposure/prediction pairing. On an injected follow-up queue failure, verify the fit remains confirmed and Refresh queue issues only reads before review resumes.

No merge, deployment, C2 work, or playback change was performed. Playback remains subject to its existing backend/SDK gates. The final chat handoff supplies the exact published commit hash.


## Correction after integration review

The initial commit `eaf7600b42f39f9ae6ebe4027202bd12169b4e49` preserved confirmed fit metrics only inside `retrain()`. Root reproduced a combined failure: the post-fit queue request fails, then an explicit GET refresh recovers the queue while optional insights remain unavailable. Generic snapshot application incorrectly cleared the confirmed model.

Preservation now belongs to snapshot application and requires both the prior and incoming sessions to be Spotify sessions for this store’s bound owner. Absent insights retain the last confirmed metrics with the outage warning; repeated GET-only recovery behaves the same way. A present insights response with quarantined null metrics explicitly clears the model instead. Valid incoming metrics remain authoritative. The retrain-only fallback was removed, so it cannot bypass quarantine. Retained old metrics do not clear an ambiguous-fit error; only a valid incoming metrics response can do that.

The regression covers the exact combined failure, a second GET refresh, fresh queue adoption and a single fit POST. Additional tests verify another owner’s fresh store has no inherited metrics and quarantine works both immediately after a fit and during later refresh. All verification counts above were updated after this correction; independent follow-up review found no actionable issues. Integrate the complete branch, including the correction commit supplied in the final chat handoff, rather than the initial commit alone.
