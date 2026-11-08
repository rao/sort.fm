# Cached listening persistence

`PostgresA1Store.transaction` now supplies `getTasteContext(userId)`. It performs one owner-scoped cached SELECT and validates the stored payload: owner, source, incomplete-history flag, timestamps, error envelope and at most50 events. Missing, malformed or mismatched-owner payloads return null; no event or timestamp from another owner escapes. Reads return detached parsed values.

The reader preserves valid cached timestamps, duplicates, empty samples and provider errors. It does not refresh, deduplicate, derive play counts or decide freshness. The C1 assembler owns those interpretations; A1 loads the snapshot once at the async assembly boundary. Unobserved-track missingness is a feature-layer concern. This change never invokes Spotify or another provider.

Optional `listeningContext` coverage is separate from FeatureVector/Python inputs. C1 pages already freeze it through ExposureInput. Adaptive requests freeze it at prepare, include it in the semantic fingerprint and recover it unchanged; publication rejects omitted/changed metadata relative to the draft. Batch initial issuance, replacement and revoked-item renewal copy the original frozen candidate's coverage. Existing batches and exposures without coverage remain unchanged; original exposures are never rewritten.

No migration is required. Root-owned contract613a47e must be present, and the A/C1 async loader/assembler changes are integration dependencies. This package alone does not make listening features available to the application or alter the classifier.

Verification uses generated disposable PostgreSQL/Tiger schemas:

```sh
bun test packages/db/test/listening-context.test.ts
```

Set `TEST_DATABASE_URL` securely first. The tests cover owner isolation and malformed cache quarantine, detached/stale/error reads, adaptive recovery and provenance conflict, legacy omission, mixed legacy/new batch candidates, replacement, Undo renewal and byte-equivalent original exposure payloads.
