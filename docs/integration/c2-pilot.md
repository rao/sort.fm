# C2 controlled pilot gate

Production continues to use `C2_POLICY_ENABLED=false` and `REVIEW_SELECTION_POLICY=c1` (both are also the defaults). The accepted integration is `1b1e5e2`. No claim of improved generalization follows from policy simulations or integration fixtures.

## Evidence and limits

| Gate | Verified evidence | Remaining live proof |
| --- | --- | --- |
| Expired card recovery | API409 is emitted before command creation; frontend refreshes only a definitively rejected first attempt. Ambiguous, pending, and restored journals retain their command identity. Seven API and25 focused web tests pass. | Observe a real pilot card expire and refresh without repeating a write. |
| Combined backend | Real Fastify + disposable Tiger schemas + real local Python pass C1, epsilon-greedy and LinUCB:847 assertions. Spotify/OAuth responses are controlled authored fixtures. | Authenticated real-account pilot through the deployed candidate stack. |
| Feedback attribution | Committed KEEP is associated with its original policy exposure and actual C1 revision; duplicate commands/events do not duplicate rewards. Skip closes with null reward; Undo revokes it. Calibration and unbound C1 fallback never acquire policy rewards. Combined HTTP, database and ML tests pass. | One approved cleanup action and its eventual fit/association on the pilot account. |
| Sealed exclusions | Common database eligibility excludes every permanent Batch2 assignment, including skipped/revoked/replacement states. Training views and policy eligibility preserve the sealed split; ML learns only from an exact current permitted training example. | Recheck the account's permanent exclusions in the pilot snapshot, including future Batch3 reservations. |
| Reservation lifecycle | Database and ML suites cover exact replay, expiry, lease recovery, response loss, release, clock rollback and restart. Combined HTTP proves page reuse, committed closure, fresh selection and outage fallback. | Timed expiry/restart through the complete real-account stack; the combined HTTP smoke does not force every crash/expiry case. |
| Inspector | Optional persisted telemetry exposes policy/version/context, exploration coefficient, reward estimate, selection score, uncertainty and propensity when known. Web regression covers missing/zero/unbounded values without presenting them as calibrated probabilities. | Inspect a genuine selected pilot exposure in the browser. |
| C1 fallback | Combined HTTP tests prove disabled/default C1, policy-only503 fallback with fresh unbound exposure IDs, missing016 legacy behavior, and partial016 fail-closed behavior. C1 scoring/feedback remain operational. | Deliberate policy-only outage in the isolated pilot, without interrupting production. |

## Isolated pilot configuration

Use a separate local or preview API instance with a dedicated database schema, separate ML artifact directory and explicit single-account OAuth allowlist. Do not point a second worker at the production feedback outbox. Copy any approved account snapshot/artifacts privately; do not commit them or include them in a build context. Preserve permanent sealed reservations and all historical feedback exclusions in the copied dataset. The real-account snapshot and OAuth/session configuration are still operator setup gates, not completed steps.

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
