# Foundation assumptions and decisions

1. This session is the integration lead implementing Task 00. The user will distribute subsequent numbered briefs to parallel sessions. Implementing their OAuth/model/UI/DB features here would create ownership conflicts.
2. Existing `sort.fm/` was empty and the parent was not a Git repository. Initialize the canonical repository here on `foundation`; preserve all supplied documents in the parent.
3. User-supplied master design and implementation request authorize scaffolding and dependency setup. No separate design-approval round is needed.
4. Demo fixture data is wholly fictional, deterministic and untrained. Fresh served exposure IDs are not persisted yet. The demo bootstrap is not a real authenticated session, and no demo mutations succeed until a later owner implements isolation/state.
5. Undo retains the archive copy, restores liked state, revokes the original label, and cannot guarantee original Spotify ordering. Pending/stale undo is rejected until reconciled.
6. Strong labels activate only on confirmed completed decisions; failed/partial/ambiguous writes are not successful training events. SKIP is unlabeled.
7. Complete metric sets require >=20 held-out labels and both classes. Thresholds for beginning per-user training belong to C1; they are not claims of validated model quality.
8. User stated their source permissions review is complete. Preserve provenance but do not add a source-specific block or gate. No external source is used by this foundation.
9. No real credentials, provisioned Tiger Data database, or hosting accounts were supplied for this scope. Health therefore reports database/Spotify/ML API capabilities false. Feature routes return explicit 501 until their owner implements them.
10. Web Playback SDK requires a browser access token. The master also requires server-only Spotify tokens; resolve that tension before P1 playback, with open-in-Spotify as P0 fallback.
11. Contract version 1.0.0 is independent of master spec version 1.1. Breaking payload changes require coordinated versioning. Agent A/B/C/D acceptance of these initial fields is pending their handoffs, not asserted as complete.
