import { expect, test } from "bun:test";
import { createIdempotencyKey } from "@sortfm/contracts/client";
import { createLiveApi, createLiveClient } from "../data/live-client";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "./review";

function responseGate() {
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	return {
		started,
		release,
		async hold(response: Response) {
			// Capture the HTTP body before waiting so a later command cannot make
			// an obsolete response look current in this regression test.
			entered();
			await waiting;
			return response;
		},
	};
}

test.each(["history", "insights"] as const)(
	"review entry displays its first card before slow %s and ignores stale initial details",
	async (optional) => {
		const f = liveFixture();
		const gate = responseGate();
		let initial = true;
		const api = createLiveApi({
			fetch: (async (input, init) => {
				const response = await f.transport(input, init);
				return initial && String(input).endsWith(`/${optional}`)
					? gate.hold(response)
					: response;
			}) as typeof fetch,
		});
		const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
		let loaded = false;
		const load = store.load({ deferDetails: true }).then(() => { loaded = true; });
		try {
			await gate.started;
			await Bun.sleep(0);
			expect(loaded).toBe(true);
			expect(store.getSnapshot().loading).toBe(false);
			expect(store.getSnapshot().queue).toHaveLength(2);
			const original = store.getSnapshot().queue[0]!.track.trackId;
			initial = false;
			await store.decide("SKIP");
			await Bun.sleep(0);
			const current = store.getSnapshot();
			expect(current.queue).toHaveLength(1);
			expect(current.queue[0]!.track.trackId).not.toBe(original);
			expect(current.history[0]!.result.action).toBe("SKIP");
			gate.release();
			await Bun.sleep(0);
			expect(store.getSnapshot()).toBe(current);
		} finally {
			gate.release();
			await load;
		}
	},
);

test("fast review entry still waits for recovery history when a command journal exists", async () => {
	const f = liveFixture();
	const item = (await f.api.queue({ mode: "spotify", limit: 20, policy: "balanced" })).items[0]!;
	f.journal.write({ kind: "decide", request: {
		trackId: item.track.trackId, exposureId: item.exposure.exposureId,
		action: "UNLIKE", idempotencyKey: createIdempotencyKey(),
	} });
	const pending = f.journal.read();
	const gate = responseGate();
	const api = createLiveApi({ fetch: (async (input, init) => {
		const response = await f.transport(input, init);
		return String(input).endsWith("/history") ? gate.hold(response) : response;
	}) as typeof fetch });
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	const load = store.load({ deferDetails: true });
	try {
		await gate.started;
		await Bun.sleep(0);
		expect(store.getSnapshot().loading).toBe(true);
		await store.decide("KEEP");
		expect(f.commands).toHaveLength(0);
		expect(f.journal.read()).toEqual(pending);
	} finally {
		gate.release();
		await load;
	}
	expect(store.getSnapshot().retry).toEqual(pending);
	await store.decide("KEEP");
	expect(f.commands).toHaveLength(0);
});

test.each([
	["history", false],
	["insights", false],
	["history", true],
	["insights", true],
] as const)(
	"slow %s does not lock the confirmed next card (one-card queue: %s)",
	async (optional, oneCard) => {
		const f = liveFixture();
		const gate = responseGate();
		const api = createLiveApi({
			fetch: (async (input, init) => {
				const url = String(input);
				let response = await f.transport(input, init);
				if (oneCard && url.includes("/api/queue?")) {
					const queue = await response.json();
					response = Response.json({
						...queue,
						items: queue.items.slice(0, 1),
					});
				}
				if (f.commands.length === 1 && url.endsWith(`/${optional}`))
					return gate.hold(response);
				return response;
			}) as typeof fetch,
		});
		const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
		await store.load();
		const original = store.getSnapshot().queue[0]!;
		let finished = false;
		const command = store.decide("SKIP").then(() => {
			finished = true;
		});
		try {
			await gate.started;
			await Bun.sleep(0);
			expect(finished).toBe(true);
			expect(store.getSnapshot().busy).toBe(false);
			expect(store.getSnapshot().refreshing).toBe(false);
			expect(store.getSnapshot().departure).toBeNull();
			expect(store.getSnapshot().queue).toHaveLength(1);
			expect(store.getSnapshot().queue[0]!.track.trackId).not.toBe(
				original.track.trackId,
			);
			expect(store.getSnapshot().history[0]!.result.label).toBeNull();
			expect(f.journal.read()).toBeNull();
			await store.decide("SKIP");
			expect(f.commands).toHaveLength(2);
		} finally {
			gate.release();
			await command;
		}
	},
);

test.each([false, true])(
	"confirmed save has a separate locked queue-refresh phase (one-card queue: %s)",
	async (oneCard) => {
		const f = liveFixture();
		const gate = responseGate();
		const api = createLiveApi({
			fetch: (async (input, init) => {
				const url = String(input);
				let response = await f.transport(input, init);
				if (url.includes("/api/queue?")) {
					if (oneCard) {
						const queue = await response.json();
						response = Response.json({
							...queue,
							items: queue.items.slice(0, 1),
						});
					}
					if (f.commands.length) return gate.hold(response);
				}
				return response;
			}) as typeof fetch,
		});
		const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
		await store.load();
		const command = store.decide("SKIP");
		try {
			await gate.started;
			expect(store.getSnapshot().busy).toBe(false);
			expect(store.getSnapshot().refreshing).toBe(true);
			expect(store.getSnapshot().departure).toBeNull();
			expect(store.getSnapshot().history[0]!.result.status).toBe("COMPLETE");
			expect(store.getSnapshot().queue).toHaveLength(oneCard ? 0 : 1);
			expect(f.journal.read()).toBeNull();
			await store.decide("KEEP");
			await store.undo(store.getSnapshot().history[0]!.result.decisionId);
			expect(f.commands).toHaveLength(1);
			expect(f.history[0]!.status).toBe("COMPLETE");
		} finally {
			gate.release();
			await command;
		}
		expect(store.getSnapshot().refreshing).toBe(false);
	},
);

test.each(["decide", "undo", "refresh"] as const)(
	"late captured metadata cannot overwrite a newer %s",
	async (next) => {
		const f = liveFixture();
		const gate = responseGate();
		let stale = true;
		let version = "initial";
		const api = createLiveApi({
			fetch: (async (input, init) => {
				const url = String(input);
				let response = await f.transport(input, init);
				const optional = url.endsWith("/history") || url.endsWith("/insights");
				if (url.endsWith("/insights")) {
					const insights = await response.json();
					response = Response.json({
						...insights,
						metrics: { ...insights.metrics, modelVersion: version },
					});
				}
				if (f.commands.length && stale && optional) return gate.hold(response);
				return response;
			}) as typeof fetch,
		});
		const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
		await store.load();
		const originalExposure = store.getSnapshot().queue[0]!.exposure.exposureId;
		const command = store.decide("SKIP");
		try {
			await gate.started;
			await Bun.sleep(0);
			expect(store.getSnapshot().busy).toBe(false);
			stale = false;
			version = "newer";
			let nextFinished = false;
			const nextCommand = (
				next === "decide"
					? store.decide("KEEP")
					: next === "undo"
						? store.undo(store.getSnapshot().history[0]!.result.decisionId)
						: store.refresh()
			).then(() => {
				nextFinished = true;
			});
			await Promise.race([nextCommand, Bun.sleep(100)]);
			expect(nextFinished).toBe(true);
			await nextCommand;
			await Bun.sleep(0);
			expect(store.getSnapshot().bootstrap!.metrics!.modelVersion).toBe(
				"newer",
			);
			const current = store.getSnapshot();
			if (next === "undo") {
				expect(current.history[0]!.result.status).toBe("UNDONE");
				expect(current.queue[0]!.exposure.exposureId).not.toBe(
					originalExposure,
				);
			}
			gate.release();
			await command;
			await Bun.sleep(0);
			expect(store.getSnapshot()).toBe(current);
			expect(f.journal.read()).toBeNull();
		} finally {
			gate.release();
			await command;
		}
	},
);

test("queue-only confirmation does not clear an unresolved training error", async () => {
	const f = liveFixture();
	const gate = responseGate();
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const response = await f.transport(input, init);
			if (f.commands.length && String(input).endsWith("/insights"))
				return gate.hold(response);
			return response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	await store.retrain(); // The authored fixture rejects this unavailable endpoint.
	const failure = store.getSnapshot().retrainError;
	expect(failure).not.toBeNull();
	const command = store.decide("SKIP");
	try {
		await gate.started;
		await command;
		expect(store.getSnapshot().retrainError).toBe(failure);
	} finally {
		gate.release();
		await command;
	}
});

test("a held decision acknowledgement cannot advance the card or clear its journal", async () => {
	const f = liveFixture();
	const gate = responseGate();
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const response = await f.transport(input, init);
			return String(input).endsWith("/api/decisions")
				? gate.hold(response)
				: response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	const original = store.getSnapshot().queue[0];
	const command = store.decide("SKIP");
	try {
		await gate.started;
		expect(store.getSnapshot().queue[0]).toBe(original);
		expect(store.getSnapshot().history).toHaveLength(0);
		expect(store.getSnapshot().busy).toBe(true);
		expect(store.getSnapshot().refreshing).toBe(false);
		expect(store.getSnapshot().notice).toBe("");
		expect(f.journal.read()).not.toBeNull();
		await store.decide("KEEP");
		expect(f.commands).toHaveLength(1);
	} finally {
		gate.release();
		await command;
	}
});

test("failure to clear a confirmed command journal keeps review paused", async () => {
	const f = liveFixture();
	const store = new ReviewStore(
		createLiveClient(f.api, f.session, {
			...f.journal,
			clear: () => {
				throw new Error("Storage blocked");
			},
		}),
	);
	await store.load();
	const queueReads = f.calls.filter((call) =>
		call.url.includes("/api/queue?"),
	).length;
	await store.decide("SKIP");
	expect(store.getSnapshot().history[0]!.result.status).toBe("COMPLETE");
	expect(store.getSnapshot().refreshError).toContain("Storage blocked");
	expect(f.journal.read()).not.toBeNull();
	expect(
		f.calls.filter((call) => call.url.includes("/api/queue?")),
	).toHaveLength(queueReads);
	await store.decide("KEEP");
	expect(f.commands).toHaveLength(1);
});
