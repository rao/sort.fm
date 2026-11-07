# sort.fm foundation implementation plan

**Goal:** Complete Task 00 so independent A/B/C/D sessions can build against one tested contract.
**Architecture:** Bun workspaces contain shared Zod contracts, Fastify API, and a minimal Vite/React contract consumer. A uv/FastAPI service supplies health and authenticated, explicitly unimplemented ML boundaries. Fictional fixtures exercise API/UI wiring without external accounts.
**Tech stack:** Bun, TypeScript, Zod, Fastify, Vite, React, Python 3.11+, uv, FastAPI.
**Spec:** `/Users/ramin/Desktop/v2code/ubhacking2026/sort-fm-agent-handoffs/sort-fm-agent-handoffs/00-foundation-contracts.md` (canonical links in README).

## Constraints and decisions
- Existing `sort.fm/` is empty; use it as the canonical project root. No existing code or Git history to preserve.
- User supplied the implementation design and authorized execution; proceed without a second design approval.
- This session owns foundation only. OAuth, real mutations, ranking, polished UI, persistence, and deployment remain assigned to later briefs.
- One JS lockfile, no secrets, synthetic demo provenance, null unavailable metrics, strict four-action semantics. UNDO is a distinct endpoint and revokes a label.
- UTC ISO dates on the wire; camelCase DTOs, stable snake_case feature names. Server derives user identity; public mutation requests never accept a userId.

## Review focus
- Synthetic identifiers accidentally reaching Spotify: separate source/URI contracts and never make external calls in foundation.
- Forged user IDs or malformed mutation bodies: strict request objects and typed UUID idempotency keys.
- Baseline scores mistaken for measured probabilities: separate heuristicScore and nullable removalProbability, null evaluation values.
- Unexpected CORS origins and private errors: exact origin allowlist and generic error envelope.
- Cross-language drift: generate JSON Schema artifacts from the canonical Zod definitions and document versioning.

## Task 1 — Contracts and workspace
- [x] Create root workspace scripts, package stubs, and env examples.
- [x] Write failing contract tests for strict actions, illegal identities, score/metric bounds, feature nullability, and fixture provenance.
- [x] Implement schemas, stable feature keys, DB DTOs, route registry, seeded fixtures, typed client.
- [x] Install with Bun, verify contract tests/types, and export JSON Schema for Python.

## Task 2 — Service wiring (parallel independent health scaffold)
- [x] Python: test health, required internal authentication, and explicit unavailable model responses before adding handlers; lock uv dependencies.
- [x] API: test real Fastify injection for health/demo queue, non-demo auth, errors/CORS, disabled demo, and pending mutation boundaries.
- [x] Implement API boot/config and canonical public route registration with honest capability status.
- [x] Frontend: minimal React consumer of the actual demo queue through the typed client; visible synthetic-data and foundation status.

## Task 3 — Verification and handoff
- [x] Implement smoke scripts that boot/stop temporary services and validate HTTP responses with shared schemas.
- [x] Run clean install, TS typecheck, full tests, Vite build, Python pytest, and API/ML HTTP smoke.
- [x] Independent review of shared contracts and security boundaries; fix actionable findings with regression tests.
- [x] Publish `docs/contracts.md`, assumptions, exact outputs, acceptance gaps, and ownership handoff.

No push, external deployment, or real Spotify writes are included in this foundation gate.

## Verification ledger

Completed November 7, 2026. Root typecheck and build pass; 23 TypeScript tests and 54 Python tests pass; both real HTTP smoke scripts pass; fresh-directory locked install/typecheck/tests/build pass; real browser verified demo load, network error and retry. Independent review identified undo/exposure gaps; regression tests reproduce and cover each fix. Final reviewer completion was unavailable due to agent usage limits; final verification was completed locally. External A/B/C/D contract acknowledgment remains the next handoff step. See docs/handoffs/00-foundation.md for exact scope and remaining product gates.
