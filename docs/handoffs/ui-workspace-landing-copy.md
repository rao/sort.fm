# Shared workspace spacing and landing copy

Follow-up to 1802b54 (canonical equivalent 9372e07). The previous top gap selector only covered completion and Library; the shared workspace main now supplies 16px for active Sort, Teach, History and every other channel. Model Lab's prior inner top padding is removed so its visible gap is also 16px rather than additive.

Both landing CTAs use the BoardUI button/link primitives with equal 44px height. Requested copy:

- “One song swipe at a time” in the landing page and legacy draft; no old exact phrase remains in web source.
- “decide later” replaces “come back later” in both places.
- “Teaching mode saves preference labels without changing your library.”
- Footer: “A little less clutter. A lot more of the evolved you.” with only “evolved” italicized.
- Footer credit: “Made with ❤️ by Ramin”, with Ramin linking to https://raminr.ai. Credit remains visible on mobile.

Verification: root typecheck, web lint, production/API build, draft build, foundation HTTP smoke and diff checks pass. Root tests: 1,187 pass, 253 skip, zero fail, 7,471 assertions. Independent review found no issues. Browser confirmed active Sort/Teach/History gaps of exactly 16px, Model tab-to-heading gap of 16px, both CTAs 44px on desktop and mobile, italic computed style and exact credit href. A 390×844 mobile demo has no horizontal or vertical page overflow, and all action controls fit. Temporary iframe fixture removed. Landing screenshot: /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/landing-copy-polish.png.

No playback logic or player styles, App/store/model/API changes, account writes or deployment. Integration owner handles merge and release.
