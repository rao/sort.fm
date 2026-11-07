import { describe, expect, test } from "bun:test";
import { createIdempotencyKey } from "@sortfm/contracts/client";

import { pendingJournal } from "./live-client";
import { ReviewStore } from "../state/review";

import { liveFixture } from "../test-support/live-fixture";

describe("live adapter and command lifecycle", () => {
	test("only credentialed live routes are used; totals are not derived from history", async () => {
		const f = liveFixture();
		const store = new ReviewStore(f.client);
		await store.load();
		expect(store.getSnapshot().summary?.total).toBe(2700);
		expect(store.getSnapshot().remaining).toBe(2);
		expect(f.calls.some((c) => c.url.includes("demo"))).toBe(false);
		expect(f.calls.every((c) => c.init?.credentials === "include")).toBe(true);
		expect(f.calls.find((c) => c.url.includes("/queue?"))?.url).toContain(
			"mode=spotify",
		);
	});
	test("fictional tracks and changed accounts cannot reach mutations", async () => {
		const f = liveFixture();
		const req = {
			trackId: "demo:track",
			exposureId: crypto.randomUUID(),
			action: "UNLIKE" as const,
			idempotencyKey: createIdempotencyKey(),
		};
		await expect(f.client.decide(req)).rejects.toThrow("Fictional");
		f.session.user!.id = "another-owner";
		// The adapter binds to the authenticated identity at creation, not a mutable DTO reference.
		await expect(
			f.client.decide({ ...req, trackId: "0".repeat(22) }),
		).rejects.toThrow("account changed");
		expect(f.commands).toHaveLength(0);
	});
	test("retry survives a new store with the original key and never auto-submits on load", async () => {
		const f = liveFixture();
		const store = new ReviewStore(f.client);
		await store.load();
		f.setDecisionError(true);
		await store.decide("ARCHIVE");
		const key = f.commands[0]!.idempotencyKey;
		const restored = new ReviewStore(f.client);
		await restored.load();
		expect(f.commands).toHaveLength(1);
		expect(restored.getSnapshot().retry?.request.idempotencyKey).toBe(key);
		f.setDecisionError(false);
		await restored.retry();
		expect(f.commands.map((c) => c.idempotencyKey)).toEqual([key, key]);
		expect(f.journal.read()).toBeNull();
		expect(restored.getSnapshot().remaining).toBe(1);
	});
	test("confirmed write followed by failed refresh is not offered as a mutation retry", async () => {
		const f = liveFixture();
		const store = new ReviewStore(f.client);
		await store.load();
		f.setQueueError(true);
		await store.decide("UNLIKE");
		expect(store.getSnapshot().history[0]?.result.status).toBe("COMPLETE");
		expect(store.getSnapshot().retry).toBeNull();
		expect(f.journal.read()).toBeNull();
		expect(store.getSnapshot().refreshError).toContain("confirmed");
		await store.decide("KEEP");
		expect(f.commands).toHaveLength(1);
		f.setQueueError(false);
		await store.refresh();
		expect(store.getSnapshot().remaining).toBe(1);
	});
	test("persisted history without card metadata can still undo by server decision id", async () => {
		const f = liveFixture();
		const first = new ReviewStore(f.client);
		await first.load();
		await first.decide("ARCHIVE");
		const reloaded = new ReviewStore(f.client);
		await reloaded.load();
		const entry = reloaded.getSnapshot().history[0]!;
		expect(entry.item).toBeNull();
		await reloaded.undo(entry.result.decisionId);
		expect(reloaded.getSnapshot().history[0]?.result.status).toBe("UNDONE");
		expect(
			reloaded.getSnapshot().queue.every((i) => i.track.source === "spotify"),
		).toBe(true);
	});
	test("journal partitions accounts and refuses malformed commands", () => {
		const f = liveFixture();
		f.journal.write({
			kind: "decide",
			request: {
				trackId: "0".repeat(22),
				exposureId: crypto.randomUUID(),
				action: "KEEP",
				idempotencyKey: createIdempotencyKey(),
			},
		});
		expect(pendingJournal(f.storage, "other").read()).toBeNull();
		f.storage.setItem("sortfm:pending:v1:owner", '{"kind":"unexpected"}');
		expect(() => f.journal.read()).toThrow();
	});
});

test("reauthorization preserves a command key and permits explicit retry after reconnect", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	f.session.capabilities.spotifyWrite = false;
	await store.decide("ARCHIVE");
	const key = f.journal.read()!.request.idempotencyKey;
	expect(store.getSnapshot().terminal).toBe(true);
	expect(f.commands).toHaveLength(0);
	expect(f.journal.read()?.terminal).toBe(false);
	f.session.capabilities.spotifyWrite = true;
	const reconnected = new ReviewStore(f.client);
	await reconnected.load();
	await reconnected.retry();
	expect(f.commands[0]?.idempotencyKey).toBe(key);
	expect(f.journal.read()).toBeNull();
});
test("an authoritative UNDONE result reconciles a lost decide response without resubmission", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	await store.decide("ARCHIVE");
	const result = f.history[0]!;
	const original = f.commands[0]!;
	await f.client.undo(result.decisionId, {
		idempotencyKey: createIdempotencyKey(),
	});
	f.journal.write({ kind: "decide", request: original });
	const reloaded = new ReviewStore(f.client);
	await reloaded.load();
	expect(reloaded.getSnapshot().retry).toBeNull();
	expect(f.journal.read()).toBeNull();
	expect(f.commands).toHaveLength(1);
});
test("GET-only recovery updates the saved state without repeating a failed mutation", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	f.setDecisionError(true);
	await store.decide("KEEP");
	f.setDecisionError(false);
	await f.client.decide(f.commands[0]!);
	const before = f.commands.length;
	await store.recover();
	expect(f.commands.length).toBe(before);
	expect(store.getSnapshot().retry).toBeNull();
	expect(store.getSnapshot().remaining).toBe(1);
});
test("failed journal storage prevents a mutation from being sent", async () => {
	const f = liveFixture();
	const client = {
		...f.client,
		live: {
			...f.client.live!,
			journal: {
				...f.journal,
				write: () => {
					throw new Error("Storage blocked");
				},
			},
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("UNLIKE");
	expect(f.commands).toHaveLength(0);
	expect(store.getSnapshot().error).toContain("Storage blocked");
});

test("undo loads a fresh server exposure before another decision", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	const original = store.getSnapshot().queue[0]!;
	await store.decide("ARCHIVE");
	await store.undo(store.getSnapshot().history[0]!.result.decisionId);
	expect(store.getSnapshot().queue[0]!.track.trackId).toBe(
		original.track.trackId,
	);
	expect(store.getSnapshot().queue[0]!.exposure.exposureId).not.toBe(
		original.exposure.exposureId,
	);
	await store.decide("KEEP");
	expect(f.commands[1]!.exposureId).not.toBe(original.exposure.exposureId);
});

test("GET recovery locks out concurrent mutation retry", async () => {
	const f = liveFixture();
	let unblock: () => void = () => {};
	let wait = false;
	const client = {
		...f.client,
		live: {
			...f.client.live!,
			snapshot: async () => {
				if (wait)
					await new Promise<void>((r) => {
						unblock = r;
					});
				return f.client.live!.snapshot();
			},
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	f.setDecisionError(true);
	await store.decide("UNLIKE");
	wait = true;
	const recovery = store.recover();
	await store.retry();
	expect(f.commands).toHaveLength(1);
	unblock();
	await recovery;
});

test("UNDO_PENDING preserves the original label and retry identity until confirmed UNDONE", async () => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	let pending = true;
	const keys: string[] = [];
	const client = {
		...f.client,
		undo: async (id: string, request: Parameters<typeof f.client.undo>[1]) => {
			keys.push(request.idempotencyKey);
			if (pending)
				throw new ApiError(409, {
					code: "UNDO_PENDING",
					message: "Restoration is pending",
					retryable: true,
				});
			return f.client.undo(id, request);
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("ARCHIVE");
	await store.undo(store.getSnapshot().history[0]!.result.decisionId);
	expect(store.getSnapshot().history[0]?.result.status).toBe("COMPLETE");
	expect(store.getSnapshot().history[0]?.result.labelState).toBe("active");
	expect(store.getSnapshot().retry?.kind).toBe("undo");
	expect(store.getSnapshot().noticeUndoId).toBeNull();
	pending = false;
	await store.retry();
	expect(keys[0]).toBe(keys[1]);
	expect(store.getSnapshot().history[0]?.result.status).toBe("UNDONE");
});

test("explicit NOT_IMPLEMENTED rejection clears only its unaccepted command and allows review after upgrade", async () => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	let available = false;
	const keys: string[] = [];
	const client = {
		...f.client,
		decide: async (request: Parameters<typeof f.client.decide>[0]) => {
			keys.push(request.idempotencyKey);
			if (!available)
				throw new ApiError(501, {
					code: "NOT_IMPLEMENTED",
					message: "Review is not available yet.",
					retryable: false,
				});
			return f.client.decide(request);
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("KEEP");
	expect(f.journal.read()).toBeNull();
	expect(store.getSnapshot().retry).toBeNull();
	expect(store.getSnapshot().terminal).toBe(false);
	expect(store.getSnapshot().history).toHaveLength(0);
	expect(store.getSnapshot().queue).toHaveLength(2);
	expect(store.getSnapshot().unavailable).toBe(true);
	const reloaded = new ReviewStore(client);
	await reloaded.load();
	expect(reloaded.getSnapshot().retry).toBeNull();
	available = true;
	await reloaded.decide("KEEP");
	expect(keys).toHaveLength(2);
	expect(keys[0]).not.toBe(keys[1]);
	expect(reloaded.getSnapshot().history[0]?.result.status).toBe("COMPLETE");
});

test.each([
	[501, "UNKNOWN_FAILURE"],
	[503, "NOT_IMPLEMENTED"],
] as const)("rejection %s %s keeps recovery journal", async (status, code) => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	const client = {
		...f.client,
		decide: async () => {
			throw new ApiError(status, {
				code,
				message: "Uncertain outcome",
				retryable: false,
			});
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("KEEP");
	expect(f.journal.read()).not.toBeNull();
	expect(store.getSnapshot().retry).not.toBeNull();
	expect(store.getSnapshot().unavailable).toBe(false);
});

test("a stub response during recovery cannot erase an earlier ambiguous command", async () => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	let attempts = 0;
	const client = {
		...f.client,
		decide: async () => {
			if (++attempts === 1) throw new Error("Response lost");
			throw new ApiError(501, {
				code: "NOT_IMPLEMENTED",
				message: "Route unavailable",
				retryable: false,
			});
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("KEEP");
	const key = f.journal.read()!.request.idempotencyKey;
	await store.retry();
	expect(f.journal.read()?.request.idempotencyKey).toBe(key);
	expect(store.getSnapshot().unavailable).toBe(false);
	expect(store.getSnapshot().retry).not.toBeNull();
});

test.each(["KEEP", "SKIP"] as const)(
	"HTTP fixture supports %s Undo with a contract-valid non-provider mutation step",
	async (action) => {
		const f = liveFixture();
		const store = new ReviewStore(f.client);
		await store.load();
		await store.decide(action);
		await store.undo(f.history[0]!.decisionId);
		expect(store.getSnapshot().error).toBeNull();
		expect(store.getSnapshot().history[0]?.result.mutationStep).toBe("NONE");
		expect(store.getSnapshot().remaining).toBe(2);
	},
);

test("synthetic model metrics in a live response are isolated instead of labeled personal feedback", async () => {
	const { createLiveApi, createLiveClient } = await import("./live-client");
	const f = liveFixture();
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const response = await f.transport(input, init);
			if (String(input).endsWith("/insights")) {
				const data = await response.json();
				data.metrics.dataset = "synthetic";
				return Response.json(data);
			}
			return response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	expect(store.getSnapshot().bootstrap?.metrics).toBeNull();
	expect(store.getSnapshot().warnings.join(" ")).toContain("synthetic");
	expect(store.getSnapshot().queue).toHaveLength(2);
});
