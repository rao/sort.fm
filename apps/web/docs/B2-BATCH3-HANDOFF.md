# Batch 3 Experiments handoff

Focused display-only update, 8 November 2026. Branch: `b2-batch3-results`.
Base: approved foundation `daf747b` plus the completed Teach/history frontend
`2440e2d` (local cherry-pick `99e9c7d`, equivalent to overseer integration `93e1fd5`).
Cherry-pick only the final Batch 3 commit; do not replay the Teach dependency.

## Changes

- `src/components/Batch3Evaluation.tsx`: latest frozen prospective result panel,
  supplied counts and E2/C1 metrics, paired C1−E2 log-loss interval, interpretation,
  consumed/permanent training exclusion notice, aggregate source fingerprint.
- `src/components/ModelLab.tsx`: show Batch 3 first in Experiments and clearly label
  existing Batch 2 comparison/local evidence as historical. Existing local import,
  feedback replay, live telemetry and graph behavior retained.
- `src/components/batch3-evaluation.test.tsx` and `model-lab.test.tsx`: values,
  uncertainty, provenance, exclusion wording, ordering, independent availability
  without a Batch 2 export, and separation from live telemetry.

## Provenance and privacy

Only owner-authorized aggregates are transcribed from the completed
`evaluation-report-v1/report.md`, confirmed against its `source-hashes.json`.
Metrics SHA-256: `d63dd93c1f0dbf3e4c7886d28c6bf4c4aae4a064cdcbd64d934226cc4e0dc3d0`.
No private files, individual outcomes, identifiers, or model artifacts are included.
No backend/data/training code changes; consumed markers and permanent exclusions
are untouched. This presentation does not recompute evaluation or fit a model.

C1 has favorable point estimates on all four metrics, but every paired interval
includes zero. Superiority and equivalence are not established. Different Batch 2
and Batch 3 panels cannot support a model-learning claim.

## Verification

- `bun run typecheck`: passed.
- `bun run lint` in `apps/web`: passed (111 files).
- `bun test src` in `apps/web`: 341 passed, 0 failed, 1,705 assertions.
- `bun run build`: web production and API bundle passed. Existing Zod annotation
  and >500 kB chunk warnings remain nonfatal.
- Local browser, explicit demo: Model → Experiments shows Batch 3 first, exact
  table values and caveats; historical Batch 2 remains a separate section.
  Visual inspection confirms existing theme/typography and table layout.
- No production actions or deployment performed by B2. Backend exclusion guards
  were not re-audited because this patch has no mutation or training path.

## Integration and release

Overseer owns merge/deployment. Apply the focused commit after Teach/history,
run integrated checks, and verify Model → Experiments on the deployed build.
Batch 3 is available without local file import; Batch 2 retains its prior local
aggregate export requirement. No environment variables or migrations needed.
