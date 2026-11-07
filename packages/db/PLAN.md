# Data workstream implementation plan

Base: approved foundation plus additive contracts commit c35cd96. Ownership stays in packages/db and apps/api/src/jobs/soundnet. No shared DTO changes.

1. PostgreSQL schema + checksum-tracked transactional migrations, optional Timescale telemetry. Bun SQL with prepared statements disabled for PgBouncer. Tests use an isolated schema on TEST_DATABASE_URL.
2. Contract-validated repositories: preserved library snapshots; immutable exposures/commands; user-scoped decision CAS, labels/undo revision, archive records; model versions and deduplicated telemetry; nullable feature joins for ML.
3. Durable global SoundNet queue keyed by track/version; fencing tokens and expiring leases, transactional cache completion, durable request-start pacing and provider cooldown shared by workers.
4. Normalize documented response fields, preserve raw JSON and explicit missingness; reject malformed/error/mismatched responses. Provider transport validates IDs, times out, classifies retries. Worker bounded concurrency, adaptive reduction/ramp, capped exponential jitter, Retry-After, durable progress, graceful shutdown.
5. Test failures first: invalid/partial features, rolling rate bound across workers, retries and terminal errors, timeout/slow provider, lease recovery/stale completion, cache dedupe, tenant isolation, command conflicts and rollback.
6. Run full tests/typecheck/build, migrations twice on configured Tiger Data, SQL analytics proof; document start/resume and external smoke limitations; commit owned files only.

Recovery guarantee: committed successes are never fetched again. The external response/database commit gap cannot guarantee exactly-once provider billing without provider idempotency support. Core API does not await backfill.
