# sort.fm recording guide

Target: one **2 minute 45 second** walkthrough, with a clear cut from the public demo to the signed-in C1 product. This is a recording plan, not a claim that every flow has been recorded or that a release is deployed.

## Before recording

- Confirm the intended release is visible. Open [the public demo](https://sort.fm/?mode=demo#/review), then prepare a separate signed-in tab without `?mode=demo`. Keep account details and unrelated tabs outside the capture.
- Check artwork and one preview with an explicit Play click; leave Autoplay off until needed. The demo has **40 real classic songs**, provider artwork and streamed Apple Music/iTunes previews. Saved dates, library membership and actions are simulated; decisions last only in that tab. Reloading resets and reshuffles the demo.
- In the signed-in tab, verify Teach, Library, the real Constellation and Live model load. Use only the counts, model version and availability states actually displayed. Let pending saves settle before recording; do not start an import or press Retrain for the video.
- Keep **C2 paused** and use normal production C1. Do not open the private pilot, start/resume a research collection, upload private evidence or rerun the frozen evaluation. Prepare the recording with ordinary navigation only.

## Recording sequence

| Time | Screen and action | Suggested narration |
| --- | --- | --- |
| 0:00–0:12 | Public demo, Sort. Frame the current song and the four choices. | “sort.fm helps me revisit my music, one song at a time. This public demo uses real songs and previews, with simulated library history.” |
| 0:12–0:40 | Click Play; allow a few seconds of preview, then pause. Choose Keep or Archive on a demo song, then Skip the next. Use the visible buttons or arrow keys. | “Keep keeps a favorite. Archive saves a playlist copy before removing a like in the connected product; Unlike removes directly. Here, every action is simulated and Spotify stays unchanged.” |
| 0:40–0:55 | Show demo History and Undo one decision. | “I can inspect a choice and undo it. This demo is an interaction walkthrough; its choices do not train a model.” |
| 0:55–1:15 | Cut visibly to the signed-in tab, **Teach** (`#/calibrate`). Show the answer controls, existing feedback and synchronization status without answering. | “Now this is my connected account. Teach records Keep or Remove preferences without changing Spotify. Scores stay hidden while I answer, and saving feedback is separate from the model finishing synchronization.” |
| 1:15–1:35 | **Library → Overview**, then **Sync** if useful. Show existing counts/status; do not click Sync. | “These are server-reported library counts. Current likes and historical decisions describe different things.” |
| 1:35–2:10 | **Model → Lab → Constellation**. Use the real library, select a visible song, expand the map, and toggle **Your Music History / Current Liked Songs**. | “Music History retains eligible imported songs; Current Liked Songs filters to current membership. The map uses available audio descriptors. Nearby dots mean acoustic similarity, not a predicted preference. Keep/Remove feedback and liked membership are separate.” |
| 2:10–2:45 | **Live model**: show the supplied version, training count and available metrics. Then **Experiments → Batch 3** aggregate panel, keeping its uncertainty note in frame. | “C1 exposes its actual model state and estimates. Batch 3 compared models frozen before judgments on the same 40 held-out songs. C1's point estimates were encouraging, but the intervals do not establish superiority. That evaluation is complete and consumed, not a reusable untouched test.” |

If a graph score is absent, say “No current score supplied.” Do not describe acoustic proximity as model confidence. The separately selectable synthetic Constellation contains invented songs; it is not the 40-song public demo or the connected library.

## Observation versus real choices

The signed-in sequence above is an **observation-only tour**: no new preferences, review decisions or Spotify changes. Ordinary page navigation can still record queue/exposure telemetry; this is not a guarantee of zero database writes.

If the owner wants an actual decision on camera, substitute one deliberately chosen interaction for a tour segment. In **Teach**, Keep saves a Keep preference, Discard saves a Remove preference, and Unsure supplies no training label; Spotify membership stays unchanged. Show the confirmed result and actual synchronization state, including pending/unavailable states. Undo withdraws a saved preference.

In **Sort**, Archive and Unlike really change Spotify. Use only the owner's explicitly chosen song/action, wait for completion, and allow time for a requested Undo to settle. Do not perform arbitrary removals to manufacture footage, call a pending operation successful, or present demo Undo as real-provider proof. No manual retraining or C2 activation is part of either recording path.

## Playback or data fallback

If a demo preview fails, pause narration briefly, try one explicit Play click, then continue with the song card and controls. The Apple Music link is a provider destination, not proof audio played. For connected playback, use the displayed connection state and **Open in Spotify** if needed; do not imply browser playback works when unavailable. A silent walkthrough with narration is sufficient.

If a real view is unavailable, retain its honest unavailable state or omit that segment. Do not substitute synthetic graphs, demo counts or made-up metrics while narrating a real account. Do not use Batch 2-to-Batch 3 metric differences as proof of learning or generalize this single-listener evaluation to all listeners.

Evidence: [demo catalog and semantics](../apps/web/src/data/demo-catalog.ts), [demo client](../apps/web/src/data/demo-client.ts), [Teach/history handoff](handoffs/teach-history.md), [frozen Batch 3 panel](../apps/web/src/components/Batch3Evaluation.tsx), [UI interaction handoff](handoffs/ui-interaction-polish.md), and [integration status](integration/status.md).
