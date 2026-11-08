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
