# Connected desk polish

Base: 2ebad7d30cac5b7f4de0524c350379cf297530e9. Branch: ui-desk-polish.

Tightens Sync's inset status and action rows, collapses the oversized collection graphic, compacts Overview counts and changes its heading to “Your next sort is waiting”. Count provenance remains under an accessible disclosure. Inspector icons, model status, codes and secondary links now follow the cream/green theme with readable contrast.

The playback bar keeps track, play/pause and seek visible; connection check, volume and autoplay live under keyboard-accessible Options. Errors remain outside the disclosure in a continuously mounted live region. SDK lifecycle, permissions, provider commands, model data and API contracts are unchanged. Scoped to Connected, Dashboard, Insights, BrowserPlayback, its tests and one imported stylesheet; no App, ModelLab, Constellation or store edits.

Verification: root typecheck and production build pass; frontend lint passes; root tests 1,177 pass / 253 skip / 0 fail; foundation HTTP smoke passes. Socket tests required local socket access after sandbox bind errors. Existing build warnings concern Zod annotations and bundle size. Browser review used explicitly labeled temporary fixtures with no Spotify calls: desktop Overview, Sync complete/unavailable, Inspector, night mode, and 390px mobile with no horizontal overflow. Keyboard Enter opens/closes playback Options. Temporary fixture files removed. Independent code review's live-region issue fixed with regression coverage.

Screenshots on this host:
- /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/polish-overview.png
- /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/polish-sync.png
- /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/polish-inspector.png
- /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/polish-phone.png

Integration lead owns canonical merge/deployment. These changes apply to the integrated app entry, not the archived standalone draft.html prototype.
