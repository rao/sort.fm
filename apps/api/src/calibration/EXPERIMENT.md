# Batch 3 API handoff

Base shared contract: `872fe37`. The fixed experiment is `calibration-batch3-v1`. This implementation does not select or activate a real panel, change a classifier, migrate a database or install runtime composition.

## Public integration

Root constructs `CalibrationExperimentService(PostgresCalibrationExperimentStore, options)` and passes only `{read, skip}` through `createCalibrationModule({experiment: service, ...})`. The module registers the shared GET `/api/calibration/experiments/:experiment` and POST `.../:experiment/skip` routes with existing session, strict schema, CSRF and no-store handling. An omitted service explicitly reports unavailable. There are no browser reserve, seal, snapshot or export routes. Reserved projections are validated against the counts-only contract before serialization; malformed downstream data fails closed.

Existing calibration label/Undo routes remain unchanged apart from mapping `BATCH_NOT_READY` to a terminal 409. D must enforce phase admission inside each transaction, including guessed exposure IDs and reads that would renew exposures. D also owns A Skip without replacement, B frozen-pool replacement, permanent exclusion and strict historical eligibility. The API delegates Skip with the original idempotency key and never scores or assembles replacements.

## Private operator integration

`CalibrationExperimentReserveInputSchema` contains only `batchId`, `experiment`, `protocolVersion`, `seedPrecommit`, `research`, and `exclusionLedger`, drawn from the shared draft shape. Root verifies real precommit/artifact bytes independently before invocation. A matching hash alone does not prove an independently committed artifact. No user/browser input is authorized to invoke these methods.

`reserve(owner, input)` validates the seed tuple and exclusion digest, then reads the private saved snapshot first. An identical operator request returns its original reservation, with no candidate capture, load or score. A changed request conflicts. A new request captures D's strict eligible identity set and revisions, loads the full library context once, validates/detaches features and coverage, then scores every eligible candidate in one bounded C1 request without exposure IDs. It requires one coherent genuinely trained logistic model with real probabilities; unavailable scoring never fabricates a panel. Default assembly does not infer training permission; runtime must provide its configured cached loader/explicit rights basis. Every frozen candidate must have training permission.

The full eligible pool is sorted lexically and frozen with cards, named features, optional listening coverage and predictions. If simultaneous matching operator requests capture different drafts, D retains the first and reports an exact-draft conflict. A rereads the private snapshot and returns its original receipt only when all operator commitment/research/exclusion identity fields match; no further assembly or score occurs. A checks the returned reservation identity/revisions/digests; D atomically rechecks the complete live eligibility digest and owner revisions before publication. `snapshot` is private and read-only. `seal` accepts the shared operator input and checks the returned immutable receipt, including its canonical request fingerprint; D verifies stored candidates, chronology and zero feedback. These paths never load, score or call providers. Root retains sole responsibility for checking external research artifacts before sealing.

## Fixed selector

Algorithm: `calibration-batch3:sha256-fisher-yates-diverse:v1`.

A starts with the complete sorted eligible pool. Its random stream is SHA-256 of compact JSON `[algorithmVersion, seed, "A", counter]`, counter starting at zero, consumed as eight big-endian uint32 values per block. Rejection sampling discards values at or above `floor(2^32/bound)*bound` before applying modulo. Descending Fisher-Yates swaps index `i` with a draw in `[0,i]`. The first forty are A, each recording marginal inclusion probability `40/N`. A never inspects predictions, features or artists. The golden test pins seed 42 and the complete synthetic selection digest.

B uses the same established Batch2 diversity mechanics in an isolated entry point: full-pool label-free quantile scaling, neutral missing features, rotating save-age quartiles, primary-artist novelty, then maximum minimum squared feature distance. SHA-256 hashes of `[algorithmVersion, seed, "B", trackId]` break ties deterministically. A identities are removed before B ranking. The complete complement is frozen in selection order, with the first twenty forming the initial B roster. B records coverage-distance scores and null selection probabilities. There is no C/entropy gate. Batch2's selector, schema and route behavior are unchanged.

## Verification and limits

Synthetic tests exercise exact 40/20/0 provenance, full B complement, permutation/score independence, sparse features, invalid pools, commitments, replay, one capture/load/score, coherent C1 responses, timeouts, mutation isolation, receipt identity, reserved privacy, authorization/CSRF, unavailable capability and operator-route absence. Repository-wide tests, typecheck and build are required before handoff. Actual database admission, competing reservations and replacement/Undo lifecycle require D plus root's combined integration tests. No live-account exposure, experiment reservation or sealed artifact is created by this patch.
