# Frontend asset provenance

All runtime fonts and artwork are bundled locally. Demo songs are fictional shared-contract fixtures, without real Spotify mutation targets.

## Album artwork

`public/artwork/demo-covers.png` was generated for this implementation using the imagegen tool. It is an original 2×2 artwork sheet, displayed through CSS background positioning. No artist cover art was copied. The four artworks are reused across the twelve fictional songs.

Generation prompt:

> Use case: stylized-concept. Asset type: original fictional album artwork sprite sheet for a premium independent music application. Generate ONE square image containing exactly a 2 by 2 grid of FOUR different square album cover artworks, perfectly touching, no gutters, no borders, no text, no letters, no logos, no UI. Top left: cinematic analog photograph of an empty brutalist concrete coastal observation room, huge rectangular window opening onto a blue teal sea and pale sun, warm orange late afternoon sunlight falling across the wall and floor, strong graphic architectural framing, evocative film grain. Top right: blurred copper-orange moon reflected in rippling dark midnight ocean, expressive analog grain and minimal composition. Bottom left: cobalt blue still life of a chrome sphere on a deep blue folding fabric with strong side lighting, editorial art photography. Bottom right: ethereal pale pink and crimson photograph of a single wind-bent flower on wine burgundy background, dreamy close up. All four must feel like beautiful real independent electronic/alternative album artwork. Edge to edge and aesthetically bold, premium, subtle film grain, no typography anywhere.

## Fonts

- Manrope: official [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/manrope), `Manrope[wght].ttf`, bundled as `public/fonts/manrope.ttf` with `manrope-OFL.txt`.
- DM Sans: official [Google Fonts source](https://github.com/google/fonts/tree/main/ofl/dmsans), `DMSans[opsz,wght].ttf`, bundled as `public/fonts/dm-sans.ttf` with `dm-sans-OFL.txt`.

Both are distributed under their included SIL Open Font License. UI icons are small inline SVG primitives implemented in `src/components/ui.tsx`.
