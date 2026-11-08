# Teach and historical/current Constellation

Frontend branch: `feat/teach-history`, based on shared contracts `07fd43d`. Pair with integration-owned backend `5f2ce66`; this frontend commit does not implement API/DB/model changes or deploy anything.

## Product behavior

- Public `#/calibrate` is permanent **Teach sort.fm**. Still love it saves Keep (0), Outgrown saves Remove (1), Unsure skips locally without a supervised label. Label and Undo use existing calibration writes only; no Spotify membership or playlist writes. Separate public journal cannot restore a remembered research session or research pending command.
- Internal research presentation is retained at `#/calibrate/research`; its Batch 2/3 controls, journal, routes and protocols are unchanged. Main tabs and Review/correction behavior are preserved.
- Teach shows server-confirmed eligible training-feedback count and model synchronization revision status. Missing status is explicitly unavailable; no progress/completion percentage. Fifteen-second status polls use generation and history guards so delayed reads cannot overwrite newer answers or newer status.
- Constellation defaults to **Your Music History**; **Current Liked Songs** filters authoritative `isLiked` membership. Nodes, links, neighbors, search, keyboard selection, details and counts follow the selected view. Both views retain identical full-history coordinates and camera while toggling.
- Effective eligible Keep/Remove colors are accepted from both Teach and Review. The graph distinguishes preference from membership and current C1 estimates from acoustic proximity. Settled Review/Undo history changes, route activation, focus and explicit reload refresh the readonly snapshot. IDs/audio alone key the projection cache, so preference/membership changes do not rebuild the embedding. Same-source reads retain the camera; failed reads clear results, never substitute demo data.

## Integration contract

- `GET /api/ml/constellation/history`: strict `TasteConstellationHistorySchema`, `sortfm.constellation.v2`, full visualization-eligible retained historical pool, required per-track `isLiked:boolean`, `membershipSyncedAt:datetime|null`. v1 endpoint unchanged. All sealed/monitoring/reserved/permanently excluded identities must be removed server-side before nodes, descriptors, preferences, optional scores or counts are serialized.
- `GET /api/calibration/teach/history`: ordinary public projection using existing `CalibrationHistorySchema`; no research label/history leakage.
- `GET /api/calibration/status`: strict `TeachingStatusSchema`, eligible `trainingFeedbackCount`, durable `feedbackRevision`, matched fit receipt `synchronizedFeedbackRevision` and `modelVersion` or both null.
- Existing ordinary queue/label admission uses integration's training eligibility filter before exposure. Shared typed client methods are `constellationHistory`, `teachHistory`, `teachingStatus`.

## Validation

- Full Bun suite: **1,131 passed, 229 skipped, 0 failed; 6,403 assertions**. DB-dependent skipped tests are not represented as live-backend proof.
- TypeScript, frontend Biome lint (108 files), production web/API build, `git diff --check`, and demo-only foundation HTTP smoke passed. Build retains dependency annotation and existing bundle-size warnings.
- Independent frontend review: poll-order race reproduced, regression test failed before fix and passed after fix; reviewer independently confirmed all five Teach client tests and no remaining findings.
- Browser: actual App with an explicitly marked, temporary authored fixture (2,700 graph songs), no real account/Spotify/backend calls. Verified Teach Remove retains liked membership; Keep/Unsure/Undo update the teaching history/count; Review Unlike retains history but hides the song from Current Liked/search/details; Review Undo restores membership and effective label. Four graph reads, view toggles, reload and route changes used **one worker projection**. Zoom remained 180% across filtering/reload.
- Error checks: graph outage clears the graph with Map unavailable and no synthetic substitution; status outage shows unavailable while saved answers remain. Desktop/mobile actions readable, 390px viewport without horizontal overflow. Temporary QA entry files removed before final build.

Screenshots contain authored fixtures only:

- [Teach desktop](teach-history-screenshots/teach-desktop.jpg)
- [Teach mobile](teach-history-screenshots/teach-mobile.jpg)
- [Teach Remove still currently liked](teach-history-screenshots/current-liked.jpg)
- [History after Review Unlike](teach-history-screenshots/history-after-unlike.jpg)

Root owns combined backend integration/production acceptance. No actual Spotify mutation was used to validate this frontend branch. No C1/C2, Batch 3 research, ReviewStore, History, live-client or backend files were changed. ModelLab edits are limited to the Constellation cache/refresh props, leaving Experiments available for B2's separate result component.
