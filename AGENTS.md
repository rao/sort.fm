# sort.fm integration rules

The acceptance contract is `../sort-fm-agent-handoffs/sort-fm-master-spec-v1.1.md`.
Implementation root is this `sort.fm/` directory (the parent is not a repository).

## Ownership
- Integration lead: root configuration, `packages/contracts/**`, `scripts/**`, docs, initial service wiring.
- A: `apps/api/src/auth`, `spotify`, `library`, `reviews`, and route wiring after foundation handoff.
- B: `apps/web/**` after foundation handoff.
- C: `services/ml/**` after foundation handoff.
- D: `packages/db/**` and `apps/api/src/jobs/soundnet/**` after foundation handoff.

Read `docs/contracts.md` before implementation. Do not independently rename shared DTO fields. Propose changes to the integration lead. Work only on the numbered brief assigned to your session; preserve concurrent edits. Foundation owns scaffolding until `docs/handoffs/00-foundation.md` records verification.

Use Bun and the root `bun.lock` for JS; uv in `services/ml` for Python. Run root typecheck, tests, and relevant smoke checks. Keep all credentials server-side. P0 precedes P1. Unimplemented capabilities must return explicit errors; never fabricate metrics or successful Spotify mutations. Never use pre-2026 Spotify mutation endpoints.

The user authorized ongoing commits and normal pushes to the configured `origin`. Commit verified work within your assigned scope; preserve other sessions' changes and never force-push shared branches.
