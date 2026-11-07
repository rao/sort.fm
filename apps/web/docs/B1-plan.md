# B1 frontend implementation

Scope: apps/web only; master spec v1.1 and B1 are the product requirements. Shared contracts remain unchanged. Foundation handoff is PASS.

## Design
Charcoal canvas, warm white typography, mint primary accent, lavender Archive, blue Skip and coral Unlike. Album artwork leads. Compact horizontal navigation and a restrained side inspector keep the workspace spacious. Locally bundled Manrope and DM Sans provide expressive headings and readable controls without remote font dependencies. Original generated album artwork is a local 2×2 sprite, paired with existing fictional track metadata. Reduced motion removes decorative transitions.

## Implementation sequence
1. Typed local demo adapter and review controller: contract validation, synchronous command lock, stable retry keys, confirmed results only, skip stays unlabeled, undo restores queue position and label count.
2. Landing and app shell, asynchronous import overview, optional calibration, artwork card with pointer and keyboard controls, history/recovery, completion, dashboard and model inspector.
3. Browser verification at desktop and mobile sizes, error recovery and accessibility; root tests/typecheck/build and frontend lint. Commit only apps/web.

## Review focus
- Rapid mixed input while a request or departure animation is pending must dispatch once.
- Failed commands retain their idempotency key and do not remove the current card.
- Undo revokes labels and restores the track; SKIP never supplies a label.
- Inputs, native dialogs, modifier shortcuts and held keys must not trigger review.
- Offline assets, partial enrichment, null predictions and empty queues remain usable and honest.

## Integration
App accepts a typed ReviewClient using existing API client method signatures. B2 supplies authenticated bootstrap/session loading and the live adapter. No OAuth, backend, SDK playback, or ML implementation is part of B1. Demo state is explicitly in-memory and never writes to Spotify.
