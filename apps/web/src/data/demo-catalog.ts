import { TrackCardSchema } from "@sortfm/contracts";
import catalog from "./demo-catalog.json";

// Public iTunes metadata only. Audio is streamed directly from the provider;
// no recordings are bundled or cached. Original release years identify the era,
// even when the available recording is a later remaster or compilation.
export const demoTracks = catalog.map((song, index) => TrackCardSchema.parse({
	trackId: `demo:itunes-${song.id}`,
	source: "synthetic", // Simulated library membership, never an imported Spotify like.
	spotifyUri: null,
	title: song.title,
	artists: [{ id: null, name: song.artist }],
	album: song.album,
	imageUrl: song.imageUrl,
	durationMs: song.durationMs,
	explicit: song.explicit,
	originalAddedAt: new Date(Date.UTC(2020 + index % 6, index % 12, 7)).toISOString(),
	releaseDate: String(song.year),
	isPlayable: false, // Spotify playback is unavailable; previews use the local lookup below.
}));
const previews = new Map(catalog.map((song) => [`demo:itunes-${song.id}`, song]));
export function demoPreview(trackId: string) {
	return previews.get(trackId);
}

export function shuffledDemoTracks() {
	const tracks = [...demoTracks];
	for (let i = tracks.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[tracks[i], tracks[j]] = [tracks[j]!, tracks[i]!];
	}
	return tracks;
}
