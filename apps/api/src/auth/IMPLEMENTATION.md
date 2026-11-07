# A1 implementation plan and ledger

Goal: implement owner-only Spotify PKCE login and restart-safe Liked Songs ingestion using the frozen v1 contracts.
Spec: `../../../../../sort-fm-agent-handoffs/sort-fm-agent-handoffs/A1-spotify-oauth-import.md` and master v1.1.
Stack: Bun, TypeScript, Fastify, Zod, Node crypto. No new dependencies.

Architecture: an injectable transactional A1Store persists encrypted OAuth credentials, hashed sessions/state, and import checkpoints. The Spotify client performs bounded retries and single-flight refresh. Imports persist each page and cursor atomically and retain raw observations and original save timestamps. A Fastify registrar owns only the seven A1 routes. D implements the database port; no invented D SQL schema or migrations.

Constraints: no edits to web, ML, shared contracts or DB; no Spotify mutations; no credentials in browser; shared TrackCard/SavedTrackInput/ImportProgressInput remain canonical. Scope includes API route wiring authorized by AGENTS.md.

Review focus: replayed/cross-browser OAuth callbacks; refresh rotation under concurrency; interrupted page commits; duplicate or shifting pagination; null/local/unavailable items and truthful counts.

- [x] Auth/client: tests first for state/PKCE, cookies, encryption/tamper, owner enforcement, refresh rotation/revocation, retries/timeouts and secret-free errors; implement `auth/{config,crypto,store,service}.ts` and `spotify/{errors,http,client}.ts`.
- [x] Import: tests first for 2,700 items, duplicate pages, atomic resume, snapshot preservation, weak recent plays, changing libraries, rate limits; implement `library/{normalize,importer}.ts`.
- [x] HTTP: tests first for seven routes, CSRF, wrong owner, asynchronous sync, no GET-triggered import and safe errors; implement `auth/module.ts`, minimal `app.ts` wiring.
- [x] Verify: root typecheck/test/build/smoke; independent review; record dependency handoff, commit on `a1-spotify-oauth-import`.

Ruling: proceed without an additional design approval, per user's explicit instruction to make engineering decisions independently.
Ruling: keep documentation/tests under A1-owned directories, overriding skill-default docs paths.
Ruling: D's package exports DTOs only. Implement and contract-test its required transactional port; do not take over schema/migration ownership or claim a live Tiger Data import. Live wiring remains an explicit external dependency until D supplies the adapter.
Ruling: use Git worktree fallback because native tool returns `Not a git repository` for the parent task directory.
Baseline: foundation 25a83e4, 23 tests / 105 assertions and typecheck pass; frozen Bun install in isolated worktree passes.

Review ledger: reproduced/fixed stale refresh revocation (lease ID fence, two exchange attempts); introduced approved shared ImportMembership publication to distinguish history from current library; heartbeat keeps import ownership through long retry sequences without reviving expired leases. Each fix has a regression test observed failing then passing.
Shared updates: merged origin/foundation through efe1c5c, retaining public wire version 1.0.0. Local store.ts now re-exports integration-owned persistence types. D is active and building the adapter; live DB/OAuth proof remains separate.

Final verification record: local root typecheck/test/build/API smoke and standalone A1 Bun bundle pass. Fresh reviewer recheck finds no actionable issues. Live Tiger D-adapter test passed with13 assertions, including rollback/resume and concurrent refresh after D fixed SQLSTATE40001 retry. Spotify provider responses remained controlled fixtures. Integration lead configured canonical token encryption/session secrets after initial check. Owner allowlist remains empty; production bootstrap and live owner consent remain integration gates.
