# Real Spotify archive → unlike → Undo acceptance

Verified November 7, 2026, 16:24–16:30 America/New_York (21:24–21:30 UTC), using canonical API implementation `170c793`. The user explicitly authorized adding and testing **Thriller by Michael Jackson**. No implementation files changed for this acceptance.

## Scope and test surface

Public catalog identity: `spotify:track:2LlQb7Uoj1kKyGhlkBf9aC`, title **Thriller**, artist **Michael Jackson**, original **Thriller** album, release date1982-11-30, duration358807ms. Spotify reported the track playable without relinking. `/me` and the archive owner matched the configured authorized account.

A temporary server-side operator driver used the existing encrypted credential store and `AuthService`, normal `LibraryImporter`, full-library C1 feature assembly, an actual keyed ML prediction, `Repository.insertExposure`, `ReviewService`, `ReviewWorker`, and `FeedbackWorker`. It retained durable commands, leases, idempotency keys, effect journals, provider reconciliation, settlement and outbox delivery. It never directly settled a decision, manufactured labels, forged a session or extracted browser cookies. The existing ML service was retained; the integration lead gracefully paused the API during this exclusive operator window.

Because the newly added track was beyond the queue's100-card page limit, the operator persisted one actual exposure for the explicitly user-selected track. Its truthful selection metadata was `deterministic_baseline` / `operator:explicit-track:v1`; its features came from the full library and its immutable prediction came from C1. This is **service/repository integration evidence, not sort.fm browser-UI evidence**. Spotify desktop UI was used only for the privacy repair described below. SoundNet was not enabled.

## Observed transaction

| UTC time | Verified result |
| --- | --- |
|21:24:24|Exact track initially not liked and not archived; no managed archive existed; feedback revision0.|
|21:24:25|Current `PUT /me/library?uris=…` returned200 for this track only; subsequent contains check confirmed liked.|
|21:26:42|Normal full import completed:2769 processed/2769 total,0 failed. Track identity and original save timestamp persisted.|
|21:26:56|Actual cold C1 heuristic exposure persisted with0 trained examples and null removal probability.|
|21:26:57|Normal ARCHIVE command persisted asPENDING with its original idempotency key.|
|21:27:03–21:29:27|Privacy mismatch safely blocked progression; repaired through Spotify desktop, then API owner/public checks passed. Details below.|
|21:29:43.752|One playlist-items POST returned201 for the exact track.|
|21:29:44.369|Provider GET confirmed that track present in the archive **before** unlike. Ownership and private flag were checked again.|
|21:29:46.262|One `DELETE /me/library?uris=…` returned200; subsequent contains check confirmed not liked.|
|21:29:50|DecisionCOMPLETE/UNLIKED, active label1/train, feedback revision1 acknowledged by normal outbox worker. Actual C1 reports1 labeled/1 training example; still insufficient for a learned classifier. Same-key recovery retained the original decision identity.|
|21:30:03|Normal Undo command persisted and returned `UNDO_PENDING`; original active label remained authoritative until restoration.|
|21:30:06.020|Undo's `PUT /me/library?uris=…` returned200; subsequent contains check confirmed liked.|
|21:30:10|DecisionUNDONE/RESTORED, labelnull/revoked, revision2 acknowledged. Actual C1 reports0 labeled/0 training examples. Archive copy retained.|
|21:30:27|Final read-only verifier passed20 checks; zero pending review work, both work commands completed, both non-idempotent effects confirmed. Exclusive window released to lead.|

The integration lead independently repeated15 read-only provider/database/C1 assertions at21:31:09UTC, confirmed the final state, and restarted the local API after the exclusive window was released.

Final state: Thriller remains liked, exactly one archive copy remains, the archive is owned by the authorized account with API `public:false`, and Spotify desktop confirmed **Private Playlist**. The database retains the original pre-review saved timestamp. Spotify may assign a different timestamp when re-saving; that final provider timestamp was not captured. Library membership is2769. The original exposure's explanation is unchanged after both feedback revisions.

The operator's API trace contains exactly one playlist creation, one track insertion, one unlike, and two track saves (initial fixture setup and Undo), plus one attempted privacy-update PUT. No API track write targeted another URI. No duplicate playlist or insertion was created after recovery.

## Actual provider privacy limitation

Creation sent `public:false` and returned201 with `public:false`; the immediate playlist GET returned `public:true` for the same owner/ID. The normal worker failed closed with `ARCHIVE_NOT_PRIVATE`, leaving the track liked and the removal label inactive. No playlist insertion or unlike had occurred.

A documented, owner-checked `PUT /playlists/{id}` with `{public:false}` returned200, but repeated full GET, projected-fields GET and owner playlist-list reads still reported `public:true`. The new archive was empty throughout these checks.

The authenticated Spotify desktop app showed **Public Playlist**, with separate **Add to profile** and **Make private** actions. Selecting **Make private** for this one managed archive produced **Private Playlist** and “Playlist has been made private.” All three API readbacks then reported the correct owner and `public:false`. The **same** durable ARCHIVE command resumed after its existing retry interval, without changing guards or creating a second playlist.

Spotify documents that the Web API's public attribute controls profile/search visibility and does not change access control; client privacy is separate. See [playlist concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists) and [change playlist details](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details). Therefore this run verifies successful real mutation/Undo **after a client privacy setup step**, not unattended creation of a private archive through the Web API alone. Preserve the ownership/privacy guard and communicate this setup requirement when the mismatch occurs; do not interpret HTTP200/201 alone as confirmed private access.

## Evidence and remaining boundary

Sanitized operator evidence was handed directly to the integration lead outside Git: ordered provider status/identity checks, initial/final state, actual decision/exposure/playlist IDs, immutable prediction versions, durable work/effect records and feedback acknowledgements. Credentials, tokens, browser state and unrelated library data were not included. Private account/playlist/decision identifiers and raw real-user responses are intentionally excluded from this committed report.

No application code changed, no live database schema was altered, and no settlement or feedback row was edited manually. The verified remaining integration concern is first-archive privacy setup: API-only automatic creation did not satisfy the private-archive guard in this real account. The safe client-assisted recovery worked. A separate sort.fm browser acceptance remains outside this service-level test.
