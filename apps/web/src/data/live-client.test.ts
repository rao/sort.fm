import { describe, expect, test } from "bun:test";
import { createIdempotencyKey } from "@sortfm/contracts/client";

import { createLiveApi, createLiveClient, pendingJournal } from "./live-client";
import { ReviewStore } from "../state/review";

import {
	coldModelMetrics,
	partialAudioFeatures,
	liveFixture,
} from "../test-support/live-fixture";

test.each(["token", "play"] as const)(
	"a playback-only reconnect 401 on %s preserves the primary session",
	async (operation) => {
		let unauthorized = 0;
		let requests = 0;
		const api = createLiveApi({
			onUnauthorized: () => {
				unauthorized++;
			},
			fetch: (async (_input: Parameters<typeof fetch>[0]) => {
				requests++;
				return Response.json(
					{
						code: "PLAYBACK_RECONNECT_REQUIRED",
						message: "provider-private-detail",
						retryable: false,
					},
					{ status: 401 },
				);
			}) as typeof fetch,
		});
		await expect(
			operation === "token"
				? api.playbackToken("owner")
				: api.playOnDevice({
						trackUri: `spotify:track:${"0".repeat(22)}`,
						deviceId: "browser",
					}),
		).rejects.toThrow();
		expect(unauthorized).toBe(0);
		expect(requests).toBe(1);
	},
);

test.each(["AUTHENTICATION_REQUIRED", "PLAYBACK_RECONNECT_REQUIRED"])(
	"primary session 401 %s still invalidates login",
	async (code) => {
		let unauthorized = 0;
		const api = createLiveApi({
			onUnauthorized: () => {
				unauthorized++;
			},
			fetch: (async (_input: Parameters<typeof fetch>[0]) =>
				Response.json(
					{ code, message: "Expired", retryable: false },
					{ status: 401 },
				)) as typeof fetch,
		});
		await expect(api.session()).rejects.toThrow();
		expect(unauthorized).toBe(1);
	},
);

test("primary authentication failure on a playback endpoint still invalidates login", async () => {
	let unauthorized = 0;
	const api = createLiveApi({
		onUnauthorized: () => {
			unauthorized++;
		},
		fetch: (async (_input: Parameters<typeof fetch>[0]) =>
			Response.json(
				{
					code: "AUTHENTICATION_REQUIRED",
					message: "Expired",
					retryable: false,
				},
				{ status: 401 },
			)) as typeof fetch,
	});
	await expect(api.playbackToken("owner")).rejects.toThrow();
	expect(unauthorized).toBe(1);
});

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

test.each(["KEEP", "ARCHIVE", "SKIP", "UNLIKE"] as const)(
	"first-attempt %s on a newly reserved Batch 2 track clears only the rejected command and refreshes GET",
	async (action) => {
		const { ApiError } = await import("@sortfm/contracts/client");
		const f = liveFixture();
		const reservedId = f.items[0]!.track.trackId;
		const client = {
			...f.client,
			decide: async (request: Parameters<typeof f.client.decide>[0]) => {
				if (request.trackId === reservedId) {
					f.items.shift();
					throw new ApiError(409, { code: "BATCH_TRACK_RESERVED", message: "This song is reserved for calibration.", retryable: false });
				}
				return f.client.decide(request);
			},
		};
		const store = new ReviewStore(client);
		await store.load();
		const reads = f.calls.length;
		await store.decide(action);
		expect(f.journal.read()).toBeNull();
		expect(store.getSnapshot().retry).toBeNull();
		expect(store.getSnapshot().terminal).toBe(false);
		expect(store.getSnapshot().queue.map((item) => item.track.trackId)).not.toContain(reservedId);
		expect(f.history).toHaveLength(0);
		expect(f.commands).toHaveLength(0);
		expect(f.calls.length).toBeGreaterThan(reads);
		expect(f.calls.slice(reads).every((call) => call.init?.method !== "POST")).toBe(true);
		const reloaded = new ReviewStore(client);
		await reloaded.load();
		expect(reloaded.getSnapshot().retry).toBeNull();
		await reloaded.decide("KEEP");
		expect(f.commands).toHaveLength(1);
		expect(f.commands[0]!.trackId).not.toBe(reservedId);
	},
);

test("a rejected reserved-track command stays cleared when GET fails, with new review paused until refresh", async () => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	const store = new ReviewStore({ ...f.client, decide: async () => {
		f.items.shift();
		f.setQueueError(true);
		throw new ApiError(409, { code: "BATCH_TRACK_RESERVED", message: "Reserved for calibration", retryable: false });
	} });
	await store.load();
	await store.decide("KEEP");
	expect(f.journal.read()).toBeNull();
	expect(store.getSnapshot().queue).toHaveLength(0);
	expect(store.getSnapshot().refreshError).toBeTruthy();
	await store.decide("UNLIKE");
	expect(f.commands).toHaveLength(0);
	f.setQueueError(false);
	await store.refresh();
	expect(store.getSnapshot().queue).toHaveLength(1);
	expect(store.getSnapshot().refreshError).toBeNull();
});

test.each([false, true])("reservation rejection during recovery preserves a previously ambiguous command (committed=%s)", async (committed) => {
	const { ApiError } = await import("@sortfm/contracts/client");
	const f = liveFixture();
	let attempts = 0;
	const client = { ...f.client, decide: async (request: Parameters<typeof f.client.decide>[0]) => {
		if (++attempts === 1) {
			if (committed) await f.client.decide(request);
			throw new Error("Response lost");
		}
		throw new ApiError(409, { code: "BATCH_TRACK_RESERVED", message: "Reserved for calibration", retryable: false });
	} };
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("KEEP");
	const key = f.journal.read()!.request.idempotencyKey;
	await store.retry();
	expect(f.journal.read()?.request.idempotencyKey).toBe(key);
	expect(store.getSnapshot().retry?.request.idempotencyKey).toBe(key);
	await store.recover();
	const reloaded = new ReviewStore(client);
	await reloaded.load();
	expect(attempts).toBe(2);
	if (committed) {
		expect(f.journal.read()).toBeNull();
		expect(reloaded.getSnapshot().retry).toBeNull();
		expect(reloaded.getSnapshot().history[0]?.result.idempotencyKey).toBe(key);
	} else {
		expect(f.journal.read()?.request.idempotencyKey).toBe(key);
		expect(reloaded.getSnapshot().retry?.request.idempotencyKey).toBe(key);
	}
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
				data.metrics = { ...coldModelMetrics, labeledExamples: 1 };
				data.audioFeatures = partialAudioFeatures;
				return Response.json(data);
			}
			return response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	expect(store.getSnapshot().bootstrap?.metrics).toBeNull();
	expect(store.getSnapshot().warnings.join(" ")).toContain("synthetic");
	expect(store.getSnapshot().insights?.audioFeatures).toEqual(
		partialAudioFeatures,
	);
	expect(store.getSnapshot().queue).toHaveLength(2);
});

test("C1 empty evaluation preserves audio through first feedback, Undo-to-empty and refresh", async () => {
	const { createLiveApi, createLiveClient } = await import("./live-client");
	const f = liveFixture();
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const response = await f.transport(input, init);
			if (!String(input).endsWith("/insights")) return response;
			const data = await response.json();
			const count = f.history.filter(
				(item) => item.labelState === "active",
			).length;
			data.metrics = count
				? {
						...coldModelMetrics,
						dataset: "user_feedback",
						labeledExamples: count,
					}
				: coldModelMetrics;
			data.audioFeatures = partialAudioFeatures;
			return Response.json(data);
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	const expectEmpty = () => {
		expect(store.getSnapshot().bootstrap?.metrics).toEqual(coldModelMetrics);
		expect(store.getSnapshot().insights?.audioFeatures).toEqual(
			partialAudioFeatures,
		);
		expect(store.getSnapshot().warnings).toEqual([]);
	};
	const waitForLabels = (count: number) =>
		new Promise<void>((resolve) => {
			const unsubscribe = store.subscribe(() => {
				if (store.getSnapshot().bootstrap?.metrics?.labeledExamples === count) {
					unsubscribe();
					resolve();
				}
			});
		});
	expectEmpty();
	const feedbackReady = waitForLabels(1);
	await store.decide("KEEP");
	await feedbackReady;
	expect(store.getSnapshot().bootstrap?.metrics?.labeledExamples).toBe(1);
	const emptyReady = waitForLabels(0);
	await store.undo(f.history[0]!.decisionId);
	await emptyReady;
	expect(store.getSnapshot().history[0]?.result.labelState).toBe("revoked");
	expectEmpty();
	await store.refresh();
	expectEmpty();
});

test("computed synthetic evaluation remains quarantined while independent audio survives", async () => {
	const { createLiveApi, createLiveClient } = await import("./live-client");
	const f = liveFixture();
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const response = await f.transport(input, init);
			if (!String(input).endsWith("/insights")) return response;
			const data = await response.json();
			data.metrics = {
				...coldModelMetrics,
				status: "available",
				evaluationMethod: "fixed_holdout",
				labeledExamples: 60,
				trainedExamples: 40,
				heldOutExamples: 20,
				heldOutPositive: 10,
				heldOutNegative: 10,
				baseRate: 0.5,
				balancedAccuracy: 0.8,
				rocAuc: 0.8,
				prAuc: 0.8,
				logLoss: 0.2,
				brierScore: 0.1,
				precisionAtK: 0.8,
				evaluatedAt: "2026-11-07T16:00:00.000Z",
			};
			data.audioFeatures = partialAudioFeatures;
			return Response.json(data);
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	expect(store.getSnapshot().bootstrap?.metrics).toBeNull();
	expect(store.getSnapshot().insights?.metrics).toBeNull();
	expect(store.getSnapshot().insights?.audioFeatures).toEqual(
		partialAudioFeatures,
	);
	expect(store.getSnapshot().warnings.join(" ")).toContain("synthetic");
});


test.each(["KEEP", "SKIP"] as const)("read-only session can undo %s without requesting Spotify write access", async action => {
 const f=liveFixture(); f.session.capabilities.spotifyWrite=false;
 const store=new ReviewStore(f.client); await store.load(); await store.decide(action);
 const id=store.getSnapshot().history[0]!.result.decisionId;
 await store.undo(id);
 const result=store.getSnapshot().history.find(entry=>entry.result.decisionId===id)!.result;
 expect(result.status).toBe("UNDONE"); expect(result.mutationStep).toBe("NONE");
 expect(store.getSnapshot().queue).toHaveLength(2); expect(f.journal.read()).toBeNull();
 expect(f.calls.filter(call=>call.url.endsWith("/undo"))).toHaveLength(1);
});

test("server refusal of a write-requiring Undo remains authoritative in a read-only session", async()=>{
 const f=liveFixture();
 const api=createLiveApi({fetch:(async(input,init)=> String(input).endsWith("/undo") ? Response.json({code:"CAPABILITY_REQUIRED",message:"Library write access is required to restore this like.",retryable:false},{status:403}) : f.transport(input,init)) as typeof fetch});
 const store=new ReviewStore(createLiveClient(api,f.session,f.journal));
 await store.load(); await store.decide("ARCHIVE"); f.session.capabilities.spotifyWrite=false;
 const id=store.getSnapshot().history[0]!.result.decisionId; await store.undo(id);
 expect(store.getSnapshot().history[0]!.result.status).toBe("COMPLETE");
 expect(store.getSnapshot().history[0]!.result.labelState).toBe("active");
 expect(store.getSnapshot().error).toContain("Library write access is required");
 expect(f.journal.read()?.kind).toBe("undo");
});

test("Undo still rejects an account switch before issuing a command", async()=>{
 const f=liveFixture(); const store=new ReviewStore(f.client);await store.load();await store.decide("KEEP");
 f.session.user!.id="different-owner";
 await store.undo(store.getSnapshot().history[0]!.result.decisionId);
 expect(f.calls.filter(call=>call.url.endsWith("/undo"))).toHaveLength(0);
 expect(store.getSnapshot().history[0]!.result.status).toBe("COMPLETE");
});
