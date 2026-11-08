import { expect, test } from "bun:test";
import { ApiError, createIdempotencyKey } from "@sortfm/contracts/client";
import { createLiveApi, createLiveClient } from "./live-client";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "../state/review";

const preparing = () =>
	Response.json(
		{
			code: "QUEUE_PREPARING",
			message: "Your next songs are still being prepared. Try again shortly.",
			retryable: true,
		},
		{ status: 503 },
	);

test("equivalent queue queries share one request and one preparation retry, then release the read", async () => {
	const f = liveFixture();
	let calls = 0;
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const api = createLiveApi({
		fetch: (async (input, init) => {
			calls++;
			if (calls === 1) {
				await held;
				return preparing();
			}
			return f.transport(input, init);
		}) as typeof fetch,
	});
	const first = api.queue();
	const second = api.queue({ limit: 20, policy: "balanced", mode: "spotify" });
	const concurrentCalls = calls;
	release();
	const values = await Promise.all([first, second]);
	expect(concurrentCalls).toBe(1);
	expect(calls).toBe(2);
	expect(values[0]).toBe(values[1]);
	await api.queue();
	expect(calls).toBe(3);
});
test("different queue parameters never coalesce", async () => {
	const f = liveFixture();
	const requests: string[] = [];
	const api = createLiveApi({
		fetch: (async (input, init) => {
			requests.push(String(input));
			return f.transport(input, init);
		}) as typeof fetch,
	});
	await Promise.all([
		api.queue({ limit: 1 }),
		api.queue({ limit: 2 }),
		api.queue({ policy: "discovery" }),
		api.queue({ mode: "demo" }),
	]);
	expect(new Set(requests).size).toBe(4);
});
test("two preparation responses stop automatic retry and retain the typed error", async () => {
	let calls = 0;
	const api = createLiveApi({
		fetch: (async (_input: Parameters<typeof fetch>[0]) => {
			calls++;
			return preparing();
		}) as typeof fetch,
	});
	try {
		await api.queue();
		throw new Error("Expected queue failure");
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).error.code).toBe("QUEUE_PREPARING");
	}
	expect(calls).toBe(2);
	await expect(api.queue()).rejects.toThrow();
	expect(calls).toBe(4);
});
test.each([401, 403, 409])(
	"queue status %s without retry permission sends one request",
	async (status) => {
		let calls = 0;
		const api = createLiveApi({
			fetch: (async (_input: Parameters<typeof fetch>[0]) => {
				calls++;
				return Response.json(
					{ code: "REJECTED", message: "Rejected", retryable: status !== 409 },
					{ status },
				);
			}) as typeof fetch,
		});
		await expect(api.queue()).rejects.toThrow();
		expect(calls).toBe(1);
	},
);
test("preparation failure leaves an unfinished command intact and manual load recovery never submits it", async () => {
	const f = liveFixture();
	let blocked = true;
	let queueCalls = 0;
	const api = createLiveApi({
		fetch: (async (input, init) => {
			if (String(input).includes("/api/queue?")) {
				queueCalls++;
				if (blocked) return preparing();
			}
			return f.transport(input, init);
		}) as typeof fetch,
	});
	const item = f.items[0]!;
	const command = {
		kind: "decide" as const,
		terminal: false,
		request: {
			trackId: item.track.trackId,
			exposureId: item.exposure.exposureId,
			action: "KEEP" as const,
			idempotencyKey: createIdempotencyKey(),
		},
	};
	f.journal.write(command);
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	expect(queueCalls).toBe(2);
	expect(store.getSnapshot().error).toContain("still being prepared");
	expect(f.journal.read()).toEqual(command);
	blocked = false;
	await store.load();
	expect(store.getSnapshot().bootstrap).not.toBeNull();
	expect(store.getSnapshot().retry).toEqual(command);
	expect(f.commands).toHaveLength(0);
	expect(f.journal.read()).toEqual(command);
});
test("retryable decision writes are not automatically retried", async () => {
	const f = liveFixture();
	let posts = 0;
	const api = createLiveApi({
		fetch: (async (_input: Parameters<typeof fetch>[0]) => {
			posts++;
			return preparing();
		}) as typeof fetch,
	});
	await expect(
		api.decide({
			trackId: f.items[0]!.track.trackId,
			exposureId: f.items[0]!.exposure.exposureId,
			action: "KEEP",
			idempotencyKey: createIdempotencyKey(),
		}),
	).rejects.toThrow();
	expect(posts).toBe(1);
});

test("raw network failures and invalid responses do not trigger a queue replay", async () => {
	for (const invalidResponse of [false, true]) {
		let calls = 0;
		const api = createLiveApi({
			fetch: (async (_input: Parameters<typeof fetch>[0]) => {
				calls++;
				if (invalidResponse) return Response.json({ invalid: true });
				throw new TypeError("Network unavailable");
			}) as typeof fetch,
		});
		await expect(api.queue()).rejects.toThrow();
		expect(calls).toBe(1);
	}
});
