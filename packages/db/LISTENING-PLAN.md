# Cached listening persistence follow-up

Root approved this separate follow-up after immutable C2 commit5035ddc. Frozen shared contract613a47e is applied as a310435. Own only packages/db; no new migration, provider requests, classifier changes, frozen-vector rewriting or production writes.

1. Add generated PostgreSQL regressions for owner-scoped detached cache reads, malformed/foreign payload quarantine, original timestamps/error/incomplete sample preservation, exact adaptive metadata recovery/publication and frozen batch initial/replacement/Undo issuance.
2. Implement cached A1Transaction.getTasteContext, validate structural payload and owner. Missing or invalid cache returns null; valid stale/error samples retain original timestamps and metadata for C1's freshness interpretation. Never derive features or perform network I/O here.
3. Accept optional frozen adaptive draft listeningContext in D's strict parser; publication must preserve it exactly. Copy frozen candidate listeningContext when issuing new batch exposures. Existing snapshots that omit it stay omitted.
4. Run focused generated local and actual Tiger tests, full local suite, typecheck/build and review the diff. Commit separately and send root/A1 the immutable hash. Root owns activation/integration and A/C1 own loading/missingness.

## Verification ledger

All three focused tests failed for the missing reader/strict-parser support/batch metadata copy before implementation. After implementation, local PostgreSQL and actual Tiger generated schemas each passed3 tests/161 assertions. The final local full suite passed860 tests,12 environment-dependent skips,0 failures,5585 assertions across93 files. Typecheck and build passed; only existing third-party Zod annotation warnings. `git diff --check` passed. Root received the small source diff for integration review. Cached locked Python dependencies were installed offline in this isolated worktree for existing C1 integration tests. No migration, production data write, provider request, existing exposure rewrite, public push or model change was performed.
