# Teach and constellation polish

The ordinary Teach flow now says Keep / Discard / Unsure and Undo. Its shortcut hint is centered beneath the choices, and the answer guide is always visible. History labels, swipe stamps and the ordinary saved notice use the same copy. The `state/calibration.ts` edit is a display string only; research labels and all submitted values are unchanged.

The constellation preserves the original A MAP OF SOUND kicker and appends “– hear the connections” inline. It has a larger drawing area, brighter/larger points, a subtle static grid and selection halo. The right legend uses the same graph tokens on its symbols with readable text. Projection, neighbors, filtering and source/missingness disclosures are unchanged.

Text inputs use an in-field underline instead of an outer focus ring. Shared BoardUI input shells have a semantic class for this styling. Keyboard focus remains visible, with an inset system-color fallback in forced-colors mode. Range, radio and checkbox focus styles are unchanged.

Verification: root typecheck; web lint; production/API and draft builds; foundation smoke; 1,187 tests passed, 253 skipped, zero failures (7,471 assertions). Existing chunk-size and Zod annotation warnings remain. Browser verified ordinary Teach Keep/Undo with a visibly labeled in-memory fixture, permanent guide, centered hint, no desktop overflow, and search click/keyboard focus. The expanded constellation was inspected using the explicitly labeled synthetic demo. Temporary fixture entries were removed.

Visual proof:
- `/Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/teach-controls-polish.png`
- `/Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/constellation-polish.png`

No connected playback component, authentication, API contract, training or model-runtime changes. The requested seek-thumb inset follows as a separate CSS-only commit for independent integration with B2's playback work.
