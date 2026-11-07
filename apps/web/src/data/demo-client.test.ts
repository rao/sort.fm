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
