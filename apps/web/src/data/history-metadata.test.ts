import { expect, test } from "bun:test";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "../state/review";
import { createHistoryMetadataLoader, historyRows } from "./history-metadata";

function metadataFixture() {
	const f = liveFixture();
	const calls: { url: string; init: RequestInit }[] = [];
	let session = f.session;
	let status = 200;
	let now = 0;
	let switchDuringMetadata = false;
	const payload = {
		schema: "sortfm.constellation.v2",
		mode: "live",
		privacy: "evaluation-excluded",
		generatedAt: "2026-11-08T00:00:00Z",
		membershipSyncedAt: null,
		modelVersion: null,
		tracks: f.items.map((item, index) => ({
			id: item.track.trackId,
			title: `Song ${index + 1}`,
			artist: `Artist ${index + 1}`,
			imageUrl: index ? null : "https://images.example.test/album.jpg",
			label: null,
			audio: {},
			prediction: null,
			isLiked: false,
		})),
	};
	const load = createHistoryMetadataLoader(
		async (url, init) => {
			calls.push({ url, init });
			if (url.endsWith("/api/me")) return Response.json(session);
			if (switchDuringMetadata)
				session = { ...session, user: { ...session.user!, id: "other" } };
			return status === 200
				? Response.json(payload)
				: new Response("Private server detail", { status });
		},
		() => now,
	);
	return {
		f,
		calls,
		load,
		payload,
		setStatus: (value: number) => {
			status = value;
		},
		switchDuringMetadata: () => {
			switchDuringMetadata = true;
		},
		advance: () => {
			now += 61_000;
		},
		switchOwner: () => {
			session = { ...session, user: { ...session.user!, id: "other" } };
		},
	};
}

test("historical metadata resolves removed songs without audio and caches only display fields", async () => {
	const f = metadataFixture();
	const tracks = await f.load("owner", new AbortController().signal);
	expect(tracks.get(f.f.items[0]!.track.trackId)).toEqual({
		id: f.f.items[0]!.track.trackId,
		title: "Song 1",
		artist: "Artist 1",
		imageUrl: "https://images.example.test/album.jpg",
	});
	expect(tracks.get(f.f.items[1]!.track.trackId)?.imageUrl).toBeNull();
	await f.load("owner", new AbortController().signal);
	expect(
		f.calls.filter((call) => call.url.endsWith("/constellation/history")),
	).toHaveLength(1);
	for (const call of f.calls)
		expect(call.init).toMatchObject({
			method: "GET",
			credentials: "include",
			cache: "no-store",
			redirect: "error",
		});
	f.advance();
	await f.load("owner", new AbortController().signal);
	expect(
		f.calls.filter((call) => call.url.endsWith("/constellation/history")),
	).toHaveLength(2);
});

test("metadata failures, synthetic payloads and account switches never return cached foreign details", async () => {
	const f = metadataFixture();
	await f.load("owner", new AbortController().signal);
	f.switchOwner();
	await expect(f.load("owner", new AbortController().signal)).rejects.toThrow(
		"Song details unavailable",
	);
	const failed = metadataFixture();
	failed.setStatus(503);
	await expect(
		failed.load("owner", new AbortController().signal),
	).rejects.toThrow("Song details unavailable");
	const invalid = metadataFixture();
	invalid.payload.mode = "synthetic";
	await expect(
		invalid.load("owner", new AbortController().signal),
	).rejects.toThrow("Song details unavailable");
	const changing = metadataFixture();
	changing.switchDuringMetadata();
	await expect(
		changing.load("owner", new AbortController().signal),
	).rejects.toThrow("Song details unavailable");
});

test("all action types use matching historical metadata for search without inventing exposure linkage", async () => {
	const f = metadataFixture();
	const store = new ReviewStore(f.f.client);
	const originalCard = structuredClone(f.f.items[0]!);
	await store.load();
	await store.decide("KEEP");
	const original = store.getSnapshot().history[0]!;
	const history = ["KEEP", "ARCHIVE", "UNLIKE", "SKIP"].map((action) => ({
		item: null,
		result: {
			...original.result,
			action: action as typeof original.result.action,
		},
	}));
	const metadata = await f.load("owner", new AbortController().signal);
	const rows = historyRows(history, [], metadata, "all", "artist 1");
	expect(rows).toHaveLength(4);
	expect(
		rows.every((row) => row.track?.title === "Song 1" && row.item === null),
	).toBe(true);
	expect(historyRows(history, [], metadata, "UNLIKE", "song 1")).toHaveLength(
		1,
	);
	expect(historyRows(history, [], new Map(), "all", "song 1")).toHaveLength(0);
	expect(historyRows(history, [], new Map(), "all", "")[0]?.track).toBeNull();
	const fresh = originalCard;
	fresh.exposure.exposureId = crypto.randomUUID();
	const known = historyRows(history, [fresh], metadata, "all", "");
	expect(known[0]!.track?.title).toBe(fresh.track.title);
	expect(known[0]!.item).toBeNull();
	expect(rows.map((row) => row.result)).toEqual(
		history.map((row) => row.result),
	);
	const undone = {
		...history[0]!,
		result: {
			...history[0]!.result,
			status: "UNDONE" as const,
			label: null,
			labelState: "revoked" as const,
			canUndo: false,
		},
	};
	const partial = historyRows(
		[
			undone,
			{
				...history[1]!,
				result: { ...history[1]!.result, trackId: "z".repeat(22) },
			},
		],
		[],
		metadata,
		"all",
		"",
	);
	expect(partial[0]!.result).toBe(undone.result);
	expect(partial[0]!.track?.title).toBe("Song 1");
	expect(partial[1]!.track).toBeNull();
});

test("configured API origin is used for both owner checks and historical metadata", async () => {
	const fixture = metadataFixture();
	const urls: string[] = [];
	const load = createHistoryMetadataLoader(
		async (url) => {
			urls.push(url);
			return Response.json(
				url.endsWith("/api/me") ? fixture.f.session : fixture.payload,
			);
		},
		Date.now,
		"https://api.example.test/",
	);
	await load("owner", new AbortController().signal);
	expect(urls).toEqual([
		"https://api.example.test/api/me",
		"https://api.example.test/api/ml/constellation/history",
		"https://api.example.test/api/me",
	]);
});

test("a delayed owner check cannot return another caller's cache or clear it", async () => {
	const fixture = metadataFixture();
	let resolveFirst!: (response: Response) => void;
	const first = new Promise<Response>((resolve) => {
		resolveFirst = resolve;
	});
	let ownerReads = 0,
		metadataReads = 0;
	const load = createHistoryMetadataLoader(async (url) => {
		if (url.endsWith("/api/me")) {
			if (++ownerReads === 1) return first;
			return Response.json({
				...fixture.f.session,
				user: { ...fixture.f.session.user!, id: "other" },
			});
		}
		metadataReads++;
		return Response.json(fixture.payload);
	});
	const old = load("owner", new AbortController().signal).then(
		(value) => ({ value, error: null }),
		(error) => ({ value: null, error }),
	);
	const current = await load("other", new AbortController().signal);
	resolveFirst(Response.json(fixture.f.session));
	expect((await old).error?.message).toBe("Song details unavailable");
	expect(await load("other", new AbortController().signal)).toBe(current);
	expect(metadataReads).toBe(1);
});

test("a late metadata response cannot overwrite a newer owner's cache", async () => {
	const fixture = metadataFixture();
	let owner = "owner",
		metadataReads = 0;
	let resolveOld!: (response: Response) => void;
	let started!: () => void;
	const oldStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const oldResponse = new Promise<Response>((resolve) => {
		resolveOld = resolve;
	});
	const load = createHistoryMetadataLoader(async (url) => {
		if (url.endsWith("/api/me"))
			return Response.json({
				...fixture.f.session,
				user: { ...fixture.f.session.user!, id: owner },
			});
		if (++metadataReads === 1) {
			started();
			return oldResponse;
		}
		return Response.json(fixture.payload);
	});
	const old = load("owner", new AbortController().signal).then(
		(value) => ({ value, error: null }),
		(error) => ({ value: null, error }),
	);
	await oldStarted;
	owner = "other";
	const current = await load("other", new AbortController().signal);
	owner = "owner";
	resolveOld(Response.json(fixture.payload));
	expect((await old).error?.message).toBe("Song details unavailable");
	owner = "other";
	expect(await load("other", new AbortController().signal)).toBe(current);
	expect(metadataReads).toBe(2);
});
