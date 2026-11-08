# Real Spotify archive → unlike → Undo acceptance

Verified November 7, 2026 using canonical API implementation `170c793`. The user authorized a selected-track provider acceptance. Account-specific catalog identity, library totals, label counts and detailed operation timestamps are retained privately. No implementation files changed for this acceptance.

## Scope and test surface

Catalog identity, playability and authorized ownership were checked through the normal service boundary. This public report omits the selected track and its association with a listener or library.

A temporary server-side operator driver used the existing encrypted credential store and `AuthService`, normal `LibraryImporter`, full-library C1 feature assembly, an actual keyed ML prediction, `Repository.insertExposure`, `ReviewService`, `ReviewWorker`, and `FeedbackWorker`. It retained durable commands, leases, idempotency keys, effect journals, provider reconciliation, settlement and outbox delivery. It never directly settled a decision, manufactured labels, forged a session or extracted browser cookies. The existing ML service was retained; the integration lead gracefully paused the API during this exclusive operator window.

Because the selected track was beyond the queue's 100-card page limit, the operator persisted one actual exposure for the explicitly user-selected track. Its truthful selection metadata was `deterministic_baseline` / `operator:explicit-track:v1`; its features came from the full library and its immutable prediction came from C1. This is **service/repository integration evidence, not sort.fm browser-UI evidence**. Spotify desktop UI was used only for the privacy repair described below. SoundNet was not enabled.

## Verified transaction properties

- Standard provider setup and a normal full import persisted the selected track through the existing importer. Private evidence retains account-specific import and state diagnostics.
- Full-library feature assembly produced an actual keyed C1 exposure with honest model availability; no prediction or feedback value was fabricated.
- ARCHIVE persisted before side effects, retained its original idempotency key, and stopped safely when provider privacy readbacks contradicted the requested state.
- After the client privacy repair described below, the same durable command resumed. Archive presence and private ownership were confirmed before unlike.
- Undo preserved the original active label until provider restoration was confirmed, then revoked feedback through the normal worker. Original exposure explanations remained immutable.
- Same-key recovery preserved command identity. Account-specific label counts, revisions and final library state remain private.
- The final read-only verifier passed 20 checks, confirmed command/effect settlement, and released the exclusive operator window.

The integration lead independently repeated 15 read-only provider/database/C1 assertions, confirmed the transaction invariants, and restarted the local API after the exclusive window was released.

Provider/database readbacks verified restoration, private ownership and original saved-timestamp preservation. Re-saving may assign a different provider timestamp; that final timestamp was not captured. No account-specific final library state is published here.

The operator's API trace contains exactly one playlist creation, one track insertion, one unlike, and two track saves (initial fixture setup and Undo), plus one attempted privacy-update PUT. No API track write targeted another URI. No duplicate playlist or insertion was created after recovery.

## Actual provider privacy limitation

Creation sent `public:false` and returned201 with `public:false`; the immediate playlist GET returned `public:true` for the same owner/ID. The normal worker failed closed with `ARCHIVE_NOT_PRIVATE`, leaving the track liked and the removal label inactive. No playlist insertion or unlike had occurred.

A documented, owner-checked `PUT /playlists/{id}` with `{public:false}` returned200, but repeated full GET, projected-fields GET and owner playlist-list reads still reported `public:true`. The new archive was empty throughout these checks.

The authenticated Spotify desktop app showed **Public Playlist**, with separate **Add to profile** and **Make private** actions. Selecting **Make private** for this one managed archive produced **Private Playlist** and “Playlist has been made private.” All three API readbacks then reported the correct owner and `public:false`. The **same** durable ARCHIVE command resumed after its existing retry interval, without changing guards or creating a second playlist.

Spotify documents that the Web API's public attribute controls profile/search visibility and does not change access control; client privacy is separate. See [playlist concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists) and [change playlist details](https://developer.spotify.com/documentation/web-api/reference/change-playlist-details). Therefore this run verifies successful real mutation/Undo **after a client privacy setup step**, not unattended creation of a private archive through the Web API alone. Preserve the ownership/privacy guard and communicate this setup requirement when the mismatch occurs; do not interpret HTTP200/201 alone as confirmed private access.

## Evidence and remaining boundary

Private operator evidence was handed directly to the integration lead outside Git: ordered provider checks, account-specific initial/final state, decision/exposure/playlist identifiers, immutable prediction versions, durable work/effect records and feedback acknowledgements. Credentials, tokens and browser state were excluded. The public report preserves engineering verification without exposing listener identity, selected catalog associations or private aggregate diagnostics.

No application code changed, no live database schema was altered, and no settlement or feedback row was edited manually. The verified remaining integration concern is first-archive privacy setup: API-only automatic creation did not satisfy the private-archive guard in this real account. The safe client-assisted recovery worked. A separate sort.fm browser acceptance remains outside this service-level test.
