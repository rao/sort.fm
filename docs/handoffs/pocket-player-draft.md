# Pocket player UI draft

Local preview: `http://127.0.0.1:5198/draft.html#/review`
Landing page: `http://127.0.0.1:5198/draft.html#/home`

## Direction

The user's references are Webdrift (https://www.webdrift.be/en), Iqbal Surya's Phosphor OS (https://iqbalsurya.com/), PHIN (https://phin.helenadang.work/), and Previously Installed (https://previouslyinstalled.com/). Their requested direction is a retro MP3 player crossed with Tinder: tactile, animated, fun, clearly labeled, and easy to navigate. Model details and playback should be easy to reveal or hide.

This prototype explores silver hardware, charcoal LCD panels, an orange play control, Bricolage Grotesque headings, and restrained monospace device labels. The whole flow is represented: home, review, calibration rehearsal, library, history, model inspector, and import. Desktop has a sidebar; phones have five labeled navigation tabs. Night mode changes both the workspace and device shell.

## What works

- Review uses the existing demo client and ReviewStore. Swipe in four directions, use labeled wheel buttons, or arrow keys. Z undoes the latest decision. The sleeve animates with the selected direction; repeated commands are gated during settlement/transition.
- Keep, archive, unlike, skip, progress, history filtering/search and Undo operate on this tab's fictional collection. Reload resets the draft.
- Milestones celebrate reviewing three/six/twelve songs without favoring a keep or remove answer.
- Details opens context, model status and up-next alongside the player. Playback is independently toggleable and defaults closed on phones.
- Optional interface sounds are off by default. They are brief synthesized button tones, not track playback.
- The library searches by song, artist or album. Calibration is explicitly an interaction rehearsal: it advances examples but saves no research labels.
- Model metrics use the untrained fixture. No model-quality numbers are invented. Fictional tracks have no playable audio; the play control explains this.
- Route/sleeve/panel/progress motion uses Motion with reduced-motion support; the decorative equalizer is static. BoardUI buttons and React Aria search fields supply shared interaction foundations. UI Skills baseline-ui and fixing-motion-performance guided the draft.

## Isolation and build

`apps/web/draft.html` and `src/draft/` are a separate entry. The working app still uses `index.html` and its existing routes. No model, API, database or research code changed.

`bun run --filter @sortfm/web build:draft` builds the prototype into ignored `apps/web/dist-draft/`. The regular build does not include the prototype entry. This is a design exploration, not yet a production migration; component extraction, route splitting, and connections to real playback/calibration are follow-up implementation work once the visual direction is chosen. Vite reports a 619 KB prototype JS chunk (196 KB gzip); split this before production adoption.

Run the local server with `bun run --filter @sortfm/web dev --port 5198`.

## Validation

- `bun run typecheck` passed.
- `bun run build` and the separate draft build passed. Existing Zod comment-annotation warnings remain; draft bundle-size warning noted above.
- `bun test`: 736 passed, 127 skipped, 0 failed. Skipped suites need external integration services.
- Browser checks: desktop review and expanded details; mobile at 390 × 844; night mode; drag-to-keep; keyboard keep; archive and Undo; history; library search; calibration rehearsal; model inspector; playback visibility; progress milestone. No horizontal page overflow observed on the phone viewport.
- Prototype-only visual work was manually verified instead of adding implementation-mirroring tests.

Kept local on `ui-boardui-foundation`. No push, merge or deployment performed.

## Draft 03 — music desktop revision

User feedback: make the whole experience more playful, chunky and retro; remove the action toast entirely. Added a separate `retro.css` layer with cream window surfaces, green patterned desktop, colorful beveled navigation keys, framed library sleeves, warmer plastic hardware, and locally bundled VT323 pixel lettering. Ordinary descriptive text remains Verdana for readability. The treatment covers all draft routes, with phone navigation and night-mode tokens.

Removed the visible toast and its dismiss state/styles. Decision feedback remains in the sleeve, progress and history; a visually hidden live region announces the settled result to screen readers. Undo stays on the player and in History. Desktop details now start open at 1100px and wider, and can be hidden with the same Details control.

Validation for this revision: typecheck and the draft build passed; all 176 frontend tests passed. Browser verified Keep with zero toast elements, player Undo, library layout, desktop and 390px phone layout with no horizontal page overflow. The previous full-suite result above applies to draft 02; this revision is limited to prototype styling and toast presentation.

### Follow-up: control refinement and Model Lab

Player keys now change text/icon color on hover without the filled highlight. Unlike uses a thumbs-down icon; player copy is exactly “Archive keeps a playlist copy before unliking. Unlike removes directly.” Channels use Sort, Teach, Library, History, Model.

Model Lab replaces the draft inspector at `draft.html#/insights`; the connected app exposes it at `#/model`, linked from its strip and existing Insights screen. Four views cover live model counts and held-out metrics, version-filtered served-queue probabilities/explanations, a measured frozen E1/E2/E3/C1 comparison, historical before/after feedback replay, and conditional C2 activity. Live distributions explicitly describe the loaded selected queue, not the full library. Frozen results never stand in for live model statistics. The feedback replay is a descriptive comparison of two fitted cohorts using identical frozen inputs, not online training or a causal learning curve.

Research evidence stays private. From the repository root, run `bun apps/web/scripts/prepare-model-lab.ts /absolute/path/to/completed/evaluation-v1` to prepare the ignored `apps/web/.local/model-lab-evidence.json`. The exporter verifies report/results delivery hashes and diagnostics manifest hashes, checks matching candidate populations and distributions, and exports only aggregate metrics and anonymous case aliases. No raw account/track identities, outcome labels, training vectors, model artifacts or secrets are exported. Source fingerprints cover results, report and both diagnostics. The existing completed study is supported; this is not an arbitrary future-study ingestion API.

The Vite-only `/__local/model-lab` reader permits same-origin loopback GETs and disables caching. Both direct root-relative and `/@fs` access to `.local` are denied, preserving default Vite deny patterns. It does not exist in production builds. A local JSON picker can load the prepared file into page memory for a judging walkthrough without uploading or browser persistence. Private evidence must not be copied into `public/`, imported into source, committed, or bundled. No new backend endpoint or shared DTO was invented.

C2 integration: the frontend structural adapter reads canonical optional `policyTelemetry` once merged with current contracts. It shows the recorded explore/exploit choice, selector, state/reward versions, predicted utility, exploration bonus, reasons and trained-reward count. Completed/undone review outcomes require an exact exposure match. These are review outcomes, not observed policy rewards; the browser API does not currently expose an all-time reward ledger. Missing telemetry remains unavailable and the view never activates C2. Refreshing history now joins by exposure ID so Undo requeueing the same song cannot replace the original policy/prediction record. Added a full live-fixture regression for that case.

Integration ownership: Calibration.tsx is untouched. App.tsx edits are narrow: add `model` route and refresh support, shorten nav labels and update the model strip link. The design prototype remains separate from the production app. The integration lead owns canonical merging, any Batch 3 routing conflicts, real-account acceptance and deployment.

Final validation: root typecheck passed; production frontend and separate draft builds passed (bundle-size warnings remain). Root Bun suite: **746 passed, 127 skipped, 0 failed, 4,037 assertions**; local socket tests require execution outside the restrictive socket sandbox. Ten new focused Model Lab tests cover evidence validation, probability version/provenance filtering, missing-versus-zero counts, policy linkage and Undo preservation. Local reader returned 200; direct private paths, cross-origin and cross-site reads returned 403. Both built outputs were checked for absence of private evidence fingerprints. Browser checked measured comparisons, feedback replay, C2 unavailable state, shortened navigation, exact player copy, desktop and phone layout. No production model, policy or Spotify operation was changed.

### Follow-up: scroll, mobile and accessibility polish

Frozen histogram labels use rounded whole-number ranges (0–33 / 33–67 / 67–100), with the percent unit explained in the caption; exact-third binning and measured values are unchanged. Shared square inset scrollbar styling covers the draft page, nested tables and connected Model Lab, with forced-color and Firefox fallbacks. The desktop sidebar now subtracts the draft strip from its viewport height; the profile remains visible, and the empty History screen no longer creates unnecessary scrolling at 1280 × 720. Smaller desktop heights omit the decorative collection card. Mobile playback uses a compact “No preview” label with an explicit accessible explanation. Disabled Undo/Restored controls retain full opacity.

Integration lint follow-up: semantic fieldsets for named control groups, named sections for table regions, output elements for status notices, explicit button types, stable histogram/reason keys, and complete callback dependencies. Each table retains keyboard focus and arrow-key scrolling; three attribute-local Biome suppressions document this legitimate use of tabindex. SwipeCard's decorative shortcut glyphs remain hidden from screen readers while each button retains its accessible shortcut label. No App, Calibration, backend, contracts or model logic changes.

Validation: typecheck, production frontend build and draft build passed (existing Zod annotation and bundle-size warnings remain). Focused Model Lab suite: 10 passed, 0 failed, 33 assertions. Seven touched source files passed Biome 2.3.4 lint using the web rules and the integration lead's Tailwind parser setting in an isolated temporary config; full integration lint remains the lead's check. Browser: desktop document exactly 1280 × 720, sidebar ends at 720 and profile at 702; mobile 390 × 844 preview fits its 82px control with no horizontal overflow; player/history disabled Undo opacity is 1. Comparison table keyboard ArrowRight moved scrollLeft from 0 to 40 while retaining focus and green themed thumb. Frozen distribution labels show rounded ranges. The new shell is still a separate fictional draft at draft.html; localhost itself does not prevent Spotify integration, and existing connected flows remain in index.html.
