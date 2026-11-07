import { describe, expect, test } from "bun:test";
import { createDemoClient } from "../data/demo-client";
import { ReviewStore, actionFromKey, actionFromDrag } from "./review";

async function setup(scenario?: "decision-error") {
	const client = createDemoClient({ latency: 0, scenario });
	const store = new ReviewStore(client);
	await store.load();
	return store;
}

describe("review interaction contract", () => {
	test("maps all four keys and dominant pointer axes", () => {
		expect(
			["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].map(actionFromKey),
		).toEqual(["KEEP", "ARCHIVE", "SKIP", "UNLIKE"]);
		expect(actionFromKey("Enter")).toBeNull();
		expect(actionFromDrag(100, 20)).toBe("KEEP");
		expect(actionFromDrag(-100, 20)).toBe("ARCHIVE");
		expect(actionFromDrag(20, -100)).toBe("SKIP");
		expect(actionFromDrag(20, 100)).toBe("UNLIKE");
		expect(actionFromDrag(30, 25)).toBeNull();
	});
	test("locks synchronously against rapid mixed inputs", async () => {
		const store = await setup();
		await Promise.all([store.decide("KEEP"), store.decide("UNLIKE")]);
		expect(store.getSnapshot().history).toHaveLength(1);
		expect(store.getSnapshot().queue).toHaveLength(11);
	});
	test("skip is unlabeled and undo restores original track", async () => {
		const store = await setup();
		const original = store.getSnapshot().queue[0]!.track.trackId;
		await store.decide("SKIP");
		expect(store.getSnapshot().history[0]!.result.label).toBeNull();
		await store.undo(store.getSnapshot().history[0]!.result.decisionId);
		expect(store.getSnapshot().queue[0]!.track.trackId).toBe(original);
		expect(store.getSnapshot().history[0]!.result.labelState).toBe("revoked");
	});
	test.each(["ARCHIVE", "UNLIKE"] as const)(
		"%s settles before undo and revokes its label",
		async (action) => {
			const store = await setup();
			await store.decide(action);
			const result = store.getSnapshot().history[0]!.result;
			expect(result.liked).toBe(false);
			expect(result.labelState).toBe("active");
			await store.undo(result.decisionId);
			const restored = store.getSnapshot().history[0]!.result;
			expect(restored.liked).toBe(true);
			expect(restored.label).toBeNull();
			expect(restored.status).toBe("UNDONE");
			if (action === "ARCHIVE") expect(restored.archived).toBe(true);
		},
	);
	test("failed decision keeps track and retry reuses original key", async () => {
		const store = await setup("decision-error");
		await store.decide("ARCHIVE");
		const failed = store.getSnapshot();
		expect(failed.queue).toHaveLength(12);
		expect(failed.error).not.toBeNull();
		const key = failed.retry!.request.idempotencyKey;
		await store.retry();
		expect(store.getSnapshot().history[0]!.result.idempotencyKey).toBe(key);
		expect(store.getSnapshot().error).toBeNull();
	});
});

describe("adapter response safety", () => {
	test("pending response never removes the card or advertises undo", async () => {
		const client = createDemoClient({ latency: 0 });
		const store = new ReviewStore({
			...client,
			decide: async (request) => {
				const result = await client.decide(request);
				return {
					...result,
					status: "PENDING",
					mutationStep: "PENDING",
					liked: null,
					archived: null,
					canUndo: false,
					label: null,
					labelState: "inactive",
				};
			},
		});
		await store.load();
		await store.decide("ARCHIVE");
		expect(store.getSnapshot().queue).toHaveLength(12);
		expect(store.getSnapshot().history).toHaveLength(0);
		expect(store.getSnapshot().noticeUndoId).toBeNull();
		expect(store.getSnapshot().error).toContain("settling");
	});
	test("response for the wrong song is rejected before changing the queue", async () => {
		const client = createDemoClient({ latency: 0 });
		const store = new ReviewStore({
			...client,
			decide: async (request) => ({
				...(await client.decide(request)),
				trackId: "demo:wrong-track",
			}),
		});
		await store.load();
		await store.decide("KEEP");
		expect(store.getSnapshot().queue).toHaveLength(12);
		expect(store.getSnapshot().history).toHaveLength(0);
		expect(store.getSnapshot().error).toContain("did not match");
	});
	test("restoration notification cannot undo a different song", async () => {
		const store = await setup();
		await store.decide("KEEP");
		await store.decide("ARCHIVE");
		const archived = store.getSnapshot().history[0]!.result.decisionId;
		expect(store.getSnapshot().noticeUndoId).toBe(archived);
		await store.undo(archived);
		expect(store.getSnapshot().noticeUndoId).toBeNull();
		expect(store.getSnapshot().history[1]!.result.canUndo).toBe(true);
	});
	test("load failure is retryable without creating any session decisions", async () => {
		const store = new ReviewStore(
			createDemoClient({ latency: 0, scenario: "load-error" }),
		);
		await store.load();
		expect(store.getSnapshot().bootstrap).toBeNull();
		expect(store.getSnapshot().error).not.toBeNull();
		await store.load();
		expect(store.getSnapshot().queue).toHaveLength(12);
		expect(store.getSnapshot().history).toHaveLength(0);
	});
	test("reviewing the whole collection ends with a truly empty queue", async () => {
		const store = await setup();
		for (let i = 0; i < 12; i++) await store.decide(i % 2 ? "ARCHIVE" : "KEEP");
		expect(store.getSnapshot().queue).toHaveLength(0);
		expect(store.getSnapshot().history).toHaveLength(12);
		await store.decide("UNLIKE");
		expect(store.getSnapshot().history).toHaveLength(12);
	});
});

test("each confirmation has a fresh identity even for the same song and action", async () => {
	const store = await setup();
	await store.decide("ARCHIVE");
	const first = store.getSnapshot();
	await store.undo(first.history[0]!.result.decisionId);
	await store.decide("ARCHIVE");
	expect(store.getSnapshot().notice).toBe(first.notice);
	expect(store.getSnapshot().noticeRevision).toBeGreaterThan(
		first.noticeRevision,
	);
});

test("nonretryable API failure enters recovery without repeatedly submitting", async () => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const client = createDemoClient({ latency: 0 });
	let attempts = 0;
	const store = new ReviewStore({
		...client,
		decide: async () => {
			attempts++;
			throw new ApiError(409, {
				code: "STALE_DECISION",
				message: "This decision needs recovery.",
				retryable: false,
			});
		},
	});
	await store.load();
	await store.decide("ARCHIVE");
	expect(store.getSnapshot().terminal).toBe(true);
	expect(store.getSnapshot().queue).toHaveLength(12);
	expect(store.getSnapshot().history).toHaveLength(0);
	await store.retry();
	expect(attempts).toBe(1);
});
