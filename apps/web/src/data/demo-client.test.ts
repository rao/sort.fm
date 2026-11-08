import { expect, test } from "bun:test";
import { createIdempotencyKey } from "@sortfm/contracts/client";
import { createDemoClient } from "./demo-client";

test("demo retries return the same decision and never duplicate feedback", async () => {
	const client = createDemoClient({ latency: 0 });
	const item = (await client.demoBootstrap()).queue.items[0]!;
	const request = {
		trackId: item.track.trackId,
		exposureId: item.exposure.exposureId,
		action: "ARCHIVE" as const,
		idempotencyKey: createIdempotencyKey(),
	};
	const first = await client.decide(request);
	const second = await client.decide(request);
	expect(second).toEqual(first);
	expect((await client.history()).items).toHaveLength(1);
	await expect(client.decide({ ...request, action: "KEEP" })).rejects.toThrow(
		"already been used",
	);
});

test("an archive copy remains after undo and subsequent Keep", async () => {
	const client = createDemoClient({ latency: 0 });
	const item = (await client.demoBootstrap()).queue.items[0]!;
	const request = {
		trackId: item.track.trackId,
		exposureId: item.exposure.exposureId,
		action: "ARCHIVE" as const,
		idempotencyKey: createIdempotencyKey(),
	};
	const archived = await client.decide(request);
	await client.undo(archived.decisionId, {
		idempotencyKey: createIdempotencyKey(),
	});
	const kept = await client.decide({
		...request,
		action: "KEEP",
		idempotencyKey: createIdempotencyKey(),
	});
	expect(kept.archived).toBe(true);
	expect(kept.liked).toBe(true);
});

test("demo loads a complete 1970s–2000s collection with real artwork and no Spotify access", async () => {
	const bootstrap = await createDemoClient({ latency: 0 }).demoBootstrap();
	const tracks = bootstrap.queue.items.map((item) => item.track);
	expect(tracks.length).toBeGreaterThanOrEqual(30);
	expect(tracks.length).toBeLessThanOrEqual(50);
	expect(bootstrap.queue.remaining).toBe(tracks.length);
	expect(new Set(tracks.map((track) => track.trackId)).size).toBe(tracks.length);
	for (const decade of [1970, 1980, 1990, 2000]) {
		expect(tracks.some((track) => Math.floor(Number(track.releaseDate?.slice(0, 4)) / 10) * 10 === decade)).toBe(true);
	}
	for (const track of tracks) {
		expect(track.imageUrl).toStartWith("https://");
		expect(track.spotifyUri).toBeNull();
	}
	expect(bootstrap.session.capabilities.spotifyRead).toBe(false);
	expect(bootstrap.session.capabilities.spotifyWrite).toBe(false);
});

test("a demo session keeps its shuffled order stable for queue reloads", async () => {
	const client = createDemoClient({ latency: 0 });
	const first = (await client.demoBootstrap()).queue;
	expect((await client.queue()).items).toEqual(first.items);
	const second = (await createDemoClient({ latency: 0 }).demoBootstrap()).queue;
	expect(second.items.map((item) => item.track.trackId)).not.toEqual(first.items.map((item) => item.track.trackId));
});
