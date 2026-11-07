# B1 frontend handoff

Implemented on `b1-delightful-ui`, rebased onto foundation `e88468e`. Scope is exclusively `apps/web`; shared contracts, OAuth, API routes, database and ML services are unchanged.

## Delivered experience

- Responsive landing, demo connection dialog, asynchronous library import, optional calibration, review, completion, searchable history with undo, dashboard and model inspector.
- Charcoal surfaces, locally bundled typography, original album art and consistent semantic action colors. Desktop, laptop and mobile compositions share the same controls.
- Right / left / up / down means Keep / Archive / Skip / Unlike, respectively. Pointer dragging, arrow keys and explicit buttons all use the same controller. Short drags spring back. Unlike receives destructive feedback. `Z` undoes the latest eligible decision; `?` opens shortcuts.
- Pending requests lock every decision input. Confirmed results trigger departure. Retries reuse the original idempotency key. Skip stays unlabeled; undo revokes the label and restores the song. Archive copies remain after undo.
- Loading, empty-library, unavailable prediction, missing enrichment, retryable failure and terminal-recovery states. Metrics remain untrained/unavailable until real contract data exists.
- Native modal focus handling, visible focus states, semantic controls, live confirmation announcements, a focusable main-content shortcut, reduced-motion CSS and a spring bypass.

## Run and inspect

From the repository root:

```sh
bun install --frozen-lockfile
bun run --filter @sortfm/web dev
bun run typecheck
bun test
bun run build
bun run smoke
```

From `apps/web`, run `bun run lint`. Biome is pinned to 2.3.4 through the command; it may need a network download on first use. There are no additional runtime dependencies.

The default experience uses twelve fictional songs and makes no Spotify writes. Reloading resets the in-memory demo. Test fixtures are selected with `?scenario=empty`, `?scenario=load-error` or `?scenario=decision-error`, before a route such as `#/review`. Failure scenarios fail once, so Retry can demonstrate recovery.

## B2 integration

`src/App.tsx` receives a `ReviewClient` prop. Its interface in `src/data/demo-client.ts` uses the existing shared API client signatures for `demoBootstrap`, `queue`, `decide`, `undo`, `history` and `insights`. `src/main.tsx` currently supplies `createDemoClient()`.

The current store consumes `demoBootstrap`, `decide` and `undo`; other client methods are available as seams, not a claim that live pagination or polling is already wired. B2 should provide an adapter that composes authenticated session, library, queue and metrics into the existing bootstrap DTO, then injects authenticated mutation methods. The raw HTTP client's `demoBootstrap` still loads demo data: replacing the local client wholesale would not establish a live session. Never combine fictional demo exposures with Spotify mutations.

`src/state/review.ts` owns command locking, retry identity, response validation, history and undo. Only `COMPLETE` advances a decision; only `UNDONE` restores it. Mismatched track, exposure or decision identities are rejected. Nonterminal failures retain the pending command. A nonretryable API error or terminal result pauses the session without offering an automatic replay. For live mode, B2 must reconcile persisted mutation state and provide reauthorization/recovery before releasing that lock.

The current queue, counters and completion apply to the loaded demo batch. B2 must paginate the live queue, use supplied `remaining`, and distinguish current Spotify membership (`LibrarySummary.total`) from historical reviewed counts. Exhausting one fetched page must not imply that the whole library is complete. Persist pending command keys and reload recovery in B2; current in-memory behavior only guarantees stable retry keys within this tab's lifetime.

History currently holds entries reviewed in this session, including the queue item needed for display and undo. Wire server history/pagination and enrichment into that presentation for cross-session history. Inspector and dashboard consume bootstrap data; wire `insights` refreshes and real model metrics. The displayed preview control explains that audio is unavailable in the demo; B2 owns playback availability and SDK integration. Connection controls currently explain the integration boundary; B2 owns OAuth and real import progress.

No contract changes are proposed or required for this B1 demo. A future rename of the frontend-only bootstrap seam could make live adapters clearer without changing shared DTOs.

## Code map

| File / directory | Responsibility |
| --- | --- |
| `src/App.tsx`, `src/main.tsx` | Routing, shell, dialogs, keyboard commands, client injection |
| `src/state/review.ts` | Review lifecycle, locks, retry, undo, terminal handling |
| `src/data/demo-client.ts` | Typed deterministic demo, idempotency, failure fixtures |
| `src/components/SwipeCard.tsx` | Drag gestures, spring return, action feedback |
| `src/components/` | Landing, library, history, dashboard, inspector and shared primitives |
| `src/styles.css` | Design tokens, typography, layouts, responsive and motion rules |
| `src/**/*.test.ts*` | Controller, fixture and render coverage |
| `public/artwork`, `public/fonts` | Local visual assets and font licenses |

## Verification

After rebasing onto `e88468e`:

- Root `bun test`: **42 passed, 0 failed**, including **21 frontend tests**. Coverage includes mixed rapid input, retry identity, mismatched responses, undo and label semantics, terminal failure, import recovery, queue completion and repeated confirmation notices.
- Root typecheck, production build and foundation HTTP smoke: passed. Build emits existing nonfatal Zod PURE-annotation warnings.
- Frontend Biome lint: passed, 17 source files. `git diff --check`: passed.
- Independent read-only review: no remaining actionable B1 findings after fixing terminal recovery and repeated-toast dismissal.

Production-preview browser checks passed for all four actual mouse drags, all four arrow keys, button input, `Z` undo, modal keyboard isolation, history search/undo, optional calibration, complete twelve-song flow, loading/retry/empty scenarios, and fresh Undo after repeating a dismissed decision. No browser console errors or warnings were observed.

Layouts were inspected at 1440×900, 1280×720 and 390×844. At the laptop viewport all four actions fit above the player. The mobile viewport had no horizontal overflow. Screenshots below were captured from the production preview; image pixel sizes can differ from viewport dimensions because of browser scrollbar/export scaling.

| View | Evidence |
| --- | --- |
| Landing | [Desktop screenshot](screenshots/landing-1440.jpg) |
| Library | [Desktop screenshot](screenshots/library-1440.jpg) |
| Review | [Desktop](screenshots/review-1440.jpg), [laptop](screenshots/review-laptop-1280.jpg), [mobile](screenshots/review-mobile-390.jpg) |
| Inspector | [Desktop screenshot](screenshots/inspector-1440.jpg) |
| Failed decision | [Recovery screenshot](screenshots/decision-error-1440.jpg) |
| Completion | [Completion screenshot](screenshots/completion-1440.jpg) |

Live Spotify, SDK audio, network-backed model updates, persisted recovery and server pagination were not tested or implemented in B1. Reduced-motion handling is implemented but was not tested under an OS preference override. No screen-reader or cross-browser audit was performed. These limits do not affect the verified local demo flow.
