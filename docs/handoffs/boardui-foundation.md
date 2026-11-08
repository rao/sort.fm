# BoardUI foundation for UI iteration

Branch: `ui-boardui-foundation`, based on `foundation` at `4a9face`.

The user requested BoardUI as the primary UI system, incremental adoption, and
personal direction on the design. Track review/swiping is the first area to shape.
This branch changes the web package and root dependency lockfile only, plus this
handoff. Backend, model research, contracts and production deployment are untouched.

## Setup

BoardUI CLI 0.5.9 installed the free foundations, Button and DirectionProvider.
Upstream source license is in `apps/web/BOARDUI-LICENSE`. `boardui.json` targets
the web package with `#ui` aliases; Vite and package imports resolve those aliases.
Run future CLI installs from `apps/web`; for MCP, pass that package's absolute
path as `projectDir`. The global Codex MCP registration is `boardui`, running
`npx -y boardui@latest mcp`; a fresh session is needed to expose its tools.

`src/styles/app.css` imports BoardUI and layers the existing stylesheet below
component utilities. `sortfm-theme.css` retains the existing dark/mint identity
and centralizes app overrides. The Button's primary foreground utility has one
local customization (`text-button-primary-foreground`) to keep mint buttons
legible. Preserve this adjustment when refreshing the registry source.

The four review actions now use BoardUI buttons and Remix icons. Existing handlers,
disabled/write-access guards, keyboard mapping and swipe physics are preserved.
The compact icon-over-label layout keeps all four actions visible at phone widths.
The existing mobile navigation gap/body minimum width also needed a small fix to
avoid horizontal scrolling at 320px with a visible scrollbar.

## Verification and preview

- Frozen-lockfile install, root typecheck and production build.
- Root suite: 736 passed, 127 environment-gated skips, 0 failures.
- Foundation HTTP smoke passed; socket checks require localhost permission.
- Browser: Keep advances the card, Undo restores it; labels and disabled states
  remain available. Desktop, 375px and 320px layouts inspected, plus landing page.
- Preview: `bun run --filter @sortfm/web dev --port 5198`, then
  `http://127.0.0.1:5198/?mode=demo#/review`.

This is the starting point for the user's visual direction, not a full redesign.
Keep future UI work on this branch until the integration lead imports it.
