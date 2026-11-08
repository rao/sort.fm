import { PUBLIC_ROUTES } from "@sortfm/contracts";
import type { HistoryEntry, QueueItem } from "../state/review";

export type HistoryTrack = {
	id: string;
	title: string;
	artist: string;
	imageUrl: string | null;
};
type Transport = (url: string, init: RequestInit) => Promise<Response>;

// In-memory, short-lived, one-owner display cache. Never stores scores, labels,
// membership, or exposure telemetry, and never becomes a source of decisions.
export function createHistoryMetadataLoader(
	transport: Transport = fetch,
	now = Date.now,
	baseUrl = "",
) {
	const base = baseUrl.replace(/\/$/, "");
	let cached: {
		owner: string;
		expires: number;
		tracks: Map<string, HistoryTrack>;
	} | null = null;
	let generation = 0;
	return async (
		owner: string,
		signal: AbortSignal,
	): Promise<Map<string, HistoryTrack>> => {
		const request = ++generation;
		const assertCurrent = () => {
			if (request !== generation || signal.aborted) throw new Error();
		};
		const read = async (url: string) => {
			assertCurrent();
			const response = await transport(`${base}${url}`, {
				method: "GET",
				credentials: "include",
				cache: "no-store",
				redirect: "error",
				signal,
				headers: { Accept: "application/json" },
			});
			assertCurrent();
			if (!response.ok) throw new Error();
			const payload: unknown = await response.json();
			assertCurrent();
			return payload;
		};
		const checkOwner = async () => {
			const session = PUBLIC_ROUTES.me.response.parse(
				await read(PUBLIC_ROUTES.me.path),
			);
			if (
				session.mode !== "spotify" ||
				session.user?.id !== owner ||
				signal.aborted
			)
				throw new Error();
		};
		try {
			if (cached?.owner !== owner) cached = null;
			await checkOwner();
			assertCurrent();
			if (cached?.owner === owner && cached.expires > now())
				return cached.tracks;
			const data = PUBLIC_ROUTES.constellationHistory.response.parse(
				await read(PUBLIC_ROUTES.constellationHistory.path),
			);
			await checkOwner();
			assertCurrent();
			const tracks = new Map(
				data.tracks.map(({ id, title, artist, imageUrl }) => [
					id,
					{ id, title, artist, imageUrl },
				]),
			);
			cached = { owner, tracks, expires: now() + 60_000 };
			return tracks;
		} catch {
			if (request === generation) cached = null;
			throw new Error("Song details unavailable");
		}
	};
}

export const loadHistoryMetadata = createHistoryMetadataLoader(
	fetch,
	Date.now,
	import.meta.env.VITE_API_ORIGIN,
);

// Display metadata can follow a track across exposures. The historical item is
// kept untouched so a newer prediction/policy can never describe an old action.
export function historyRows(
	history: readonly HistoryEntry[],
	queue: readonly QueueItem[],
	metadata: ReadonlyMap<string, HistoryTrack>,
	filter: string,
	search: string,
) {
	const current = new Map(
		queue.map((item) => [item.track.trackId, item.track]),
	);
	return history
		.map((entry) => {
			const card =
				entry.item?.track.trackId === entry.result.trackId
					? entry.item.track
					: current.get(entry.result.trackId);
			const historical =
				entry.result.mode === "spotify"
					? (metadata.get(entry.result.trackId) ?? null)
					: null;
			const track = card
				? {
						id: card.trackId,
						title: card.title,
						artist: card.artists.map((artist) => artist.name).join(", "),
						imageUrl: card.imageUrl ?? historical?.imageUrl ?? null,
					}
				: historical;
			return { ...entry, track };
		})
		.filter(
			({ result, track }) =>
				(filter === "all" || result.action === filter) &&
				`${track?.title ?? ""} ${track?.artist ?? ""} ${result.trackId}`
					.toLowerCase()
					.includes(search.toLowerCase()),
		);
}
