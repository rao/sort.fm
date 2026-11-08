# Interaction and readability polish

Depends on prior UI polish 13413fe and the canonical real-demo feature 28e9bad (cherry-picked locally as395c7ce). Integrate this new commit after13413fe on canonical; do not cherry-pick395c7ce again because it duplicates28e9bad.

- Smoother existing review exit/entry animations: eased230ms exit fits the unchanged240ms store settle, late fade and gentler rotation. Draft exit320ms. Reduced motion preserved; no decision lifecycle edits.
- Custom compact demo audio controls replace native white controls. Play/pause, seek, real preview URL, provider destination, errors and retry preserved. Removed courtesy sentence. Shared green/red accessible Autoplay switch for demo and Spotify player. Play cancellation is not reported as a load failure. Autoplay stays off initially. Hiding/reopening is available through an obvious Show player control.
- Native shortcuts dialogs explicitly centered with viewport bounds. Matching four-bar logo SVG favicon for app and draft.
- Repeated top strip (including stray Model Lab link) visually removed across workspace routes. Input focus is green, including Model Lab's stronger tabindex rule. Demo Connect/Continue buttons spaced.
- Teach feedback and answer guide compacted. Model field guide condensed. Saved model explanations show actual inputs and signed terms; repeated caveats deduplicated under Model notes.
- Constellation discovery rows spaced and compact. Expand map uses a single native dialog/canvas, preserves selection and camera, traps focus while modal, supports Escape/Close and restores trigger focus. Graph math/data unchanged.

No new App/store/live-client/API/contract/model changes beyond importing the existing demo dependency. No Spotify writes, model retraining or deployment.

Verification: root typecheck, production build, draft build, frontend lint, diff check and foundation HTTP smoke pass. Root tests1185 pass,253 skip,0 fail (7467 assertions). Existing Zod annotation and bundle-size warnings remain. Browser checked actual streamed preview play/pause, autoplay across demo Skip, off toggle without pausing, hide/restore, mobile390px with zero horizontal overflow, main/draft dialog centering, green input focus, compact Teach/Model views, constellation discovery and expanded view, Escape focus restore. Connected/model UI used labeled isolated fixtures; fixture files removed.

Screenshots at /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/:
- playback-refined.png (actual isolated music demo)
- playback-phone.png
- constellation-expanded.png (synthetic graph fixture, not measured results)

Current reviewable local demo: http://127.0.0.1:5198/?mode=demo#/review . Legacy draft.html remains a separate prototype; its modal/motion/restore and catalog-count compatibility are patched too.
