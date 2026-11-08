import type { z } from "zod";
import { TasteConstellationSchema } from "@sortfm/contracts";

export { audioFields, type AudioKey } from "./audio";
import { audioFields, type AudioKey } from "./audio";
// The HTTP and presentation paths share the integration-owned contract.
export const librarySchema = TasteConstellationSchema;
export type Library = z.infer<typeof librarySchema>;
export type Track = Library["tracks"][number];
export type Audio = Track["audio"];

export function parseLibrary(
	input: unknown,
): { ok: true; data: Library } | { ok: false } {
	const parsed = librarySchema.safeParse(input);
	// Never echo validation payloads, which may contain forbidden identities.
	return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
}

export function createSyntheticLibrary(count = 2700): Library {
	let seed = 71419;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const clamp = (v: number) => Math.max(0, Math.min(1, v));
	const words = [
		"Velvet Circuit",
		"Slow Satellites",
		"Amber Room",
		"Night Current",
		"Glass Orchard",
		"Quiet Signal",
		"Paper Moon",
		"Silver Hours",
	];
	return {
		schema: "sortfm.constellation.v1",
		mode: "synthetic",
		privacy: "evaluation-excluded",
		generatedAt: "2026-11-08T00:00:00Z",
		modelVersion: null,
		tracks: Array.from(
			{ length: Math.min(5000, Math.max(0, Math.floor(count))) },
			(_, i) => {
				const energy = random(),
					rhythm = random(),
					texture = random();
				const audio: Audio = {
					energy,
					danceability: clamp(0.6 * rhythm + 0.3 * energy + random() * 0.1),
					happiness: clamp(0.6 * rhythm + random() * 0.4),
					acousticness: clamp(1 - energy * 0.8 - random() * 0.2),
					instrumentalness: texture,
					liveness: random() * 0.5,
					speechiness: clamp(0.3 * (1 - texture) + random() * 0.15),
					tempo_bpm: 65 + 100 * rhythm + random() * 15,
					loudness_db: -30 + 24 * energy + random() * 3,
				};
				if (i % 17 === 16) audio.happiness = null;
				if (i % 101 === 100) {
					for (const [key] of audioFields) audio[key] = null;
				}
				return {
					id: `demo:constellation:${String(i).padStart(4, "0")}`,
					title: `${words[i % words.length]} ${String(i + 1).padStart(3, "0")}`,
					artist: `Demo ensemble ${String((i % 24) + 1).padStart(2, "0")}`,
					imageUrl: null,
					label: i % 11 === 0 ? "keep" : i % 13 === 0 ? "remove" : null,
					audio,
					prediction: null,
				};
			},
		),
	};
}

export const labelName = (label: Track["label"]) =>
	label === "keep" ? "Keep" : label === "remove" ? "Remove" : "Unlabeled";
export function formatAudio(key: AudioKey, value: number | null | undefined) {
	if (value == null) return "Unavailable";
	return key === "tempo_bpm"
		? `${value.toFixed(0)} BPM`
		: key === "loudness_db"
			? `${value.toFixed(1)} dB`
			: value.toFixed(2);
}
