# Read-only Taste Constellation projection

Approved scope: authenticated owner library metadata, observed cached musical descriptors and effective eligible training labels, at most 5,000 tracks after exclusions. The API owns authentication, response validation, generatedAt and null model/prediction fields. This store never creates exposures, calls providers/models, or mutates database state.

Root's identity-only audit confirmed that known permanent monitoring/evaluation identities are represented by historical `unified_feedback.split = holdout` or `calibration_batch_items.assignment = sealed_evaluation`. Use those full histories, including revoked/skipped/replacement records. Do not substitute the effective-feedback view for historical exclusions or exclude the entire Batch 3 snapshot ledger: that ledger also contains ordinary training identities. Apply an existing `db.reviewExclusions` deny policy additionally in pilot deployments. Any newly discovered private-only exclusions require integration review before enabling this endpoint.

Include current Spotify library members in saved/kept/deferred state. Exclude pending review/Undo, active known-track policy bindings, all sealed assignments and non-labeled train batch reservations. Include labeled train batch items only after their experiment is ready, with an effective permitted training label. A revoked ordinary train label becomes null without reviving older labels. The nine audio fields are observed cache values only; no imputation, derived preference features, listening context, outcomes, exclusion counts or artifacts are returned.

Use one repeatable-read, read-only transaction. Require intact calibration/feature/history storage, fail closed with `PersistenceError('CONSTELLATION_UNAVAILABLE')` on incomplete optional policy/Batch 3 installations or exclusion inconsistency. Query bounded keyset chunks so additional pilot exclusions apply before the final limit. PostgreSQL tests use synthetic data in unique disposable schemas only.

## Implementation and verification plan

- [x] Write PostgreSQL tests for owner isolation, historical exclusions and noninterference, eligible labels, observed missingness, missing/partial storage, and the post-filter 5,000 bound.
- [x] Implement `PostgresConstellationStore.constellation(userId)` and its narrow projection types in owned DB files; export the class without changing shared DTOs.
- [x] Run actual disposable PostgreSQL tests, full Bun suite, typecheck and build; obtain independent review.
- [ ] Commit and hand off to Root/A1. Root owns integration, source-history audit and deployment; no live/provider/model changes in this workstream.

## Integration and verified checks

Inject `new PostgresConstellationStore(db)` as A's `ConstellationReadPort`. Its `constellation(userId)` returns only `{userId, tracks}`; the API validates the authenticated owner and the full projection before adding response metadata. The fixed nine audio keys use the existing feature units. Invalid/synthetic cached vectors are represented as missing audio, not invented values. HTTP artwork becomes null; title/artist text is bounded to the agreed 200/300 characters.

Run `bun --no-env-file test packages/db/test/constellation.test.ts` with `TEST_DATABASE_URL` set to a disposable PostgreSQL instance. The tests migrate/drop unique synthetic schemas, never a production schema. Ten projection tests passed; the adjacent Batch 3 and pilot fence run passed 20 tests / 165 assertions. Full Bun suite: 1,048 passed, 216 environment-gated skips, no failures. Typecheck and web/API build passed; existing dependency annotation and web chunk-size warnings remain. Independent static privacy review found no important issues. No live database, model, provider, or deployment operation was performed by this workstream.

Root must combine this commit with A's additive shared contract/route commit and run the combined authenticated endpoint acceptance before enabling production. The graph payload intentionally contains no total/hidden counts, pagination cursor, model prediction or exclusion diagnostics.
