# Player, History and constellation follow-up

Base: foundation `bae4665`; branch: `ui-player-polish`.

## Player presentation

`c4c2486` fixes the specificity clash that let the global chunky button rule override compact playback controls. Enable and Check connection use aligned 32px controls; unhealthy player setup places them above the seek rail. B2 recovery/check/guidance/error rendering and all SDK/store callbacks are unchanged.

Range inputs retain a 24px interaction area. Track pseudo-elements draw the 12px rail, with a 10px thumb contained inside it. Unavailable/disabled thumbs use a muted token. Both browser-player and demo timelines share the geometry; native focus and Home/End seeking remain intact.

## Constellation details

`1f224ba` keeps the full “Unlabeled · no explicit label” text on one line using the installed compact caption style. Neighbor buttons use bounded text and a reserved arrow column; long names wrap without pushing arrows beyond the card. Source, feature, distance and preference semantics are unchanged.

## History metadata

History resolves names, artists and covers by exact stable track ID using existing exposure metadata, current queue display metadata or the existing authenticated historical constellation response. It copies only display fields; it never assigns newer exposures, scores or policy telemetry to historical decisions. Server filtering, evaluation exclusions and the response limit remain unchanged, with no per-ID fallback enumeration. Missing metadata/artwork is explicit.

The optional fetch honors `VITE_API_ORIGIN`, checks the owner before and after reading data, aborts on component changes, and uses a short-lived owner-scoped memory cache. Generation checks prevent stale requests from reading, replacing or clearing another owner's cache. Failure leaves actions/Undo available. Search uses resolved title/artist. Decision tags use semantic green Keep, amber Archive, rose Unlike and blue Skip; undone tags remain neutral.

## Verification

- Root tests: 1,202 pass, 253 skip, zero failures; 7,557 assertions. Includes missing/partial metadata, configured API origin, concurrent owner changes, original order/outcome and Undo preservation.
- Root typecheck, web lint, production/API build, draft build and foundation HTTP smoke passed. Existing bundle-size and dependency annotation warnings remain. Independent review found and verified fixes for API-origin routing and a concurrent cache ownership race; no remaining actionable issues.
- Browser: real demo Play/Pause and Home/End 0–30; disconnected/ready player fixtures at desktop and 390px; History search, filtering, Undo, artwork and action colors; 264px constellation sidebar with deliberately long neighbor names and every arrow contained. No live Spotify writes or model changes.
- Visual proofs in `/Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/`: `player-disconnected-compact.png`, `player-disconnected-phone.png`, `player-rail-compact.png`, `constellation-sidebar-contained.png`, `history-metadata-colors.png`. Fixtures and generated artwork are visibly labeled simulated.

Temporary QA entries were removed. The integration lead owns publishing. No backend, API contract, model-runtime or C2 changes.
