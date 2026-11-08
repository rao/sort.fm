# C2 controlled pilot gate

Production continues to use `C2_POLICY_ENABLED=false` and `REVIEW_SELECTION_POLICY=c1` (both are also the defaults). The accepted integration is `1b1e5e2`. No claim of improved generalization follows from policy simulations or integration fixtures.

## Evidence and limits

| Gate | Verified evidence | Remaining live proof |
| --- | --- | --- |
| Expired card recovery | API409 is emitted before command creation; frontend refreshes only a definitively rejected first attempt. Ambiguous, pending, and restored journals retain their command identity. Fresh verification passed seven API tests and41 web recovery/telemetry tests. The combined lifecycle test expires a real ML lease, verifies409 creates no decision or association, and reselects with a fresh exposure ID. | Observe a real pilot card expire and refresh in the browser without repeating a write. |
| Combined backend | Real Fastify + disposable Tiger schemas + real local Python pass C1, epsilon-greedy and LinUCB:847 assertions. An additional combined lifecycle case passes93 assertions. Spotify/OAuth responses are controlled authored fixtures. | Authenticated real-account pilot through the deployed candidate stack. |
| Feedback attribution | Committed KEEP is associated with its original policy exposure and actual C1 revision; duplicate commands/events do not duplicate rewards. Skip closes with null reward; Undo revokes it. Calibration and unbound C1 fallback never acquire policy rewards. Combined HTTP, database and ML tests pass. | One approved cleanup action and its eventual fit/association on the pilot account. |
| Sealed exclusions | Common database eligibility excludes every permanent Batch2 assignment, including skipped/revoked/replacement states. The combined lifecycle fixture checks permanent pending/labeled/skipped/revoked/replacement rows against every actual selection request; a submitted sealed label reaches neither C1 examples nor policy rewards. | Recheck the account's permanent exclusions in the pilot snapshot, including future Batch3 reservations. |
| Reservation lifecycle | Combined Fastify/Tiger/Python proves exact page replay across API and ML restarts, genuine30-second expiry, same-track reselection with a new ID, durable outbox release and replay, and that an old release cannot close a new reservation. Separate DB/ML suites cover lease recovery, response loss and clock rollback. | Repeat timed expiry/restart on the isolated real-account stack. Abrupt crash/fault combinations remain separate component tests. |
| Inspector | Optional persisted telemetry exposes policy/version/context, exploration coefficient, reward estimate, selection score, uncertainty and propensity when known. Web regression covers missing/zero/unbounded values without presenting them as calibrated probabilities. | Inspect a genuine selected pilot exposure in the browser. |
| C1 fallback | Combined HTTP tests prove disabled/default C1, policy-only503 fallback with fresh unbound exposure IDs, missing016 legacy behavior, and partial016 fail-closed behavior. C1 scoring/feedback remain operational. | Deliberate policy-only outage in the isolated pilot, without interrupting production. |

## Isolated pilot configuration

Use a separate local or preview API instance with a dedicated database schema, separate ML artifact directory and explicit single-account OAuth allowlist. Do not point a second worker at the production feedback outbox. Copy any approved account snapshot/artifacts privately; do not commit them or include them in a build context. Preserve permanent sealed reservations and all historical feedback exclusions in the copied dataset. The real-account snapshot and OAuth/session configuration are still operator setup gates, not completed steps.

Prepare an owner-filtered data allowlist, not a full production-schema clone. Exclude copied OAuth credentials/sessions, pending imports, review work, feedback jobs, provider queues, policy deliveries and every active lease. Runtime starts recovery workers even when new C2 selections are disabled. Verify zero inherited schedulable work before starting one pilot runtime; use fresh secrets and a database role restricted to the pilot schema. Disable import/resync, calibration and historical Undo in the pilot harness. Initially accept only KEEP, Skip and Undo of decisions created by that pilot, with provider mutations blocked by the transport boundary.

Fit only the approved frozen training snapshot into fresh pilot ML artifacts using the unchanged C1 recipe. Preserve evaluation identities for exclusion, but do not send sealed or consumed evaluation outcomes to the pilot model. Verify the training digest and actual returned fit receipt; a new local fit need not have the production artifact's model version.

Source reservation changes require an explicit coordination gate. Batch creation does not advance feedback or membership revision, so revision counters alone cannot validate a copied exclusion set. Hash the full source reservation and historical evaluation-identity sets, recheck before launch, and keep new Batch3 reservation/collection and source-account labeling paused during the short pilot. A read/check alone cannot eliminate a race with a later reservation. If that pause cannot be guaranteed, keep the pilot stopped until publication and feedback have a source-authoritative exclusion fence. No such fence or live pilot setup is claimed by the current tests.

Apply migration016 only to the pilot schema, install the accepted private policy service, and verify its authenticated association protocol and persistent storage. Keep the same supervised C1 recipe. Establish the pilot's genuine model/revision receipt from its own authoritative feedback snapshot; do not invent a fit receipt from a revision counter.

Only the isolated instance receives:

```dotenv
C2_POLICY_ENABLED=true
REVIEW_SELECTION_POLICY=epsilon_greedy
```

LinUCB can be selected in the same isolated instance after the first lifecycle pass. An unsupported or disabled configuration never silently enables it. The public production environment stays C1 throughout the pilot. Calibration is a separate source and never backfilled into policy rewards.

## Limited acceptance sequence

1. Verify source, migration checksums, account allowlist, cache freshness/missingness, permanent exclusions, and actual C1 model/revision. Check no other worker consumes this pilot schema or artifact directory.
2. Select one card; inspect its exposure ID, policy/config/context versions, observed features, uncertainty, exploration strength and recorded propensity. Refresh and confirm no duplicate reservation or selection.
3. Commit a nonmutating KEEP; wait for the database decision, full C1 feedback acknowledgement and exact policy association. Retry the same command and confirm one reward. Undo and confirm the original association becomes inactive. Test Skip separately and confirm no binary reward.
4. Let a card expire, refresh/reselect, restart the pilot API/ML, and confirm exact replay/release behavior. Interrupt only policy selection and confirm fresh C1 fallback with no later retrospective reward attribution.
5. Recheck permanent sealed exclusions and calibration isolation. Any Spotify Archive/Unlike transaction is limited to a specifically authorized track and requires explicit provider-state verification; controlled fixtures are not that proof.
6. Record the real results and failure recovery before considering any change to production defaults. This pilot validates reliability and observability; efficacy needs a separately prespecified prospective evaluation.
