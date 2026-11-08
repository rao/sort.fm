# Batch 3 runtime integration

The runtime composes `CalibrationExperimentService` with `PostgresCalibrationExperimentStore`, the existing cached listening-context loader, and the existing C1 scoring adapter. The nullable `runtime.calibrationExperiment` property is server-only. Public HTTP exposes read and skip; reserve, snapshot, candidate capture and seal remain private operator methods. No collection opens until persistence records a valid seal.

Readiness requires migrations 015/016 and the 017 migration marker, required experiment columns, and all seven enabled admission/immutability triggers. Missing or partial 017 disables the experiment port and reports `CALIBRATION_EXPERIMENT_DATABASE_UNAVAILABLE`; ordinary calibration remains available. Runtime does not apply migrations. C1 remains the default review policy.

Seal chronology now tolerates two database observations falling within one wire-format millisecond. It makes at most twenty additional database observations, each after a one-millisecond database sleep, and accepts only an actually observed time later than `checkedAt`. A nonadvancing clock still fails closed. No timestamp is synthesized.

## Verified with authored fixtures

`bun run smoke:calibration-experiment` requires an explicit `TEST_DATABASE_URL`. It creates and drops unique test schemas, uses a controlled Spotify transport, and starts actual local Python ML with a new temporary artifact directory. It never reads `.env`, calls a real provider, reserves a real panel, or opens private research artifacts.

- Actual OAuth/import routes import 108 authored tracks. Twelve persisted calibration labels train the real supervised C1, whose score produces the complete 96-candidate frozen pool.
- Reservation saves exactly A40/B20/C0 and returns only public counts. All sixty guessed label submissions fail before seal; skip, invalid Undo, direct status mutation and snapshot mutation cannot change the reservation.
- C1, epsilon-greedy and LinUCB use the same reserved-song exclusion. Real C2 requests omit the entire panel; no policy reward is attributed to calibration.
- Wrong feature binding cannot seal. Successful sealing verifies zero historical feedback and strict observed chronology. Exact replay returns the original receipt; changed artifact binding conflicts.
- Ready reads and application restart resume the same collection. A labeling, Undo and skip never enter C1 training and never produce an A replacement. B labeling enters persisted training; Undo removes it; skip chooses the next permitted member of the frozen B pool.
- Replacing the live listening cache does not change saved candidate features, predictions, renewed exposures or replacement predictions. The original C1 version's artifact and manifest hashes remain identical after later training.
- Reserve, read, seal, skip and idempotent replays do not fit a model. Reserve scores once; subsequent operations reuse the saved snapshot. Admitted labels and Undo continue the existing feedback worker.

The combined acceptance passed **2 tests / 472 assertions** against disposable local PostgreSQL and actual Python. D's separate persistence suite passed **4 tests / 43 assertions**. Full Bun tests passed **993 tests / 5,255 assertions**, with **174 explicit integration skips**. The unchanged Python suite passed **589 tests**. Typecheck, production build and foundation HTTP smoke passed. These are synthetic engineering results, not production migration, live panel, research evaluation, or real-account collection proof.

## Remaining operator gates

Apply and verify migration 017 separately in the intended deployment. Before any real reservation, commit the trusted seed artifact, bind the approved exclusion ledger and immutable research model/data/protocol files, and verify the current owner revisions. Before sealing, verify the exact external artifact bytes and snapshot/roster bindings. Deployment, production migration, actual panel capture/seal and browser collection remain integration-owner operations.
