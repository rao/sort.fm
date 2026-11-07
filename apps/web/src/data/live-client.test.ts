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
