import { expect, test } from "bun:test";
import type { ReviewResult } from "@sortfm/contracts";
import {
	createLiveApi,
	createLiveClient,
	type SettlementOptions,
} from "../data/live-client";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "./review";

function gate() {
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		started,
		release,
		wait: async () => {
			entered();
			await waiting;
		},
	};
}
function fixture(
	options: {
		pendingDecision?: boolean;
		undoResponse?: "409" | "pending";
		settleAfter?: number;
		onPoll?: (result: ReviewResult, count: number) => ReviewResult;
		transportError?: boolean;
		pendingError?: ReviewResult["error"];
		beforeRead?: (url: string) => Promise<void>;
		settlement?: SettlementOptions;
	} = {},
) {
	const f = liveFixture();
	let phase: "decide" | "undo" | null = null;
	let settled: ReviewResult | null = null;
	let polls = 0;
	let time = 0;
	const requests: { url: string; method: string }[] = [];
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const url = String(input);
			requests.push({ url, method: init?.method ?? "GET" });
			if (phase && init?.method !== "POST") await options.beforeRead?.(url);
			if (url.endsWith("/api/decisions")) {
				if (options.transportError)
					throw new TypeError("Authored ambiguous response loss");
				const response = await f.transport(input, init);
				if (options.pendingDecision === false) return response;
				settled = structuredClone(await response.json());
				Object.assign(f.history[0]!, {
					status: "PENDING",
					mutationStep: "PENDING",
					liked: null,
					archived: null,
					label: null,
					labelState: "inactive",
					canUndo: false,
					feedbackRevision: 0,
					error: options.pendingError ?? null,
				});
				phase = "decide";
				return Response.json(f.history[0], { status: 202 });
			}
			if (url.endsWith("/undo")) {
				const original = structuredClone(f.history[0]!);
				settled = structuredClone(
					await (await f.transport(input, init)).json(),
				);
				Object.assign(f.history[0]!, original);
				phase = "undo";
				polls = 0;
				if (options.undoResponse === "pending")
					return Response.json(
						{
							...original,
							status: "PENDING",
							mutationStep: "PENDING",
							label: null,
							labelState: "inactive",
							canUndo: false,
							error: options.pendingError ?? null,
						},
						{ status: 202 },
					);
				return Response.json(
					{
						code: "UNDO_PENDING",
						message: "Undo is saved and awaiting confirmation.",
						retryable: true,
					},
					{ status: 409 },
				);
			}
			if (url.endsWith("/api/decisions/history") && phase) {
				polls++;
				if (polls >= (options.settleAfter ?? 2))
					Object.assign(f.history[0]!, settled);
				if (options.onPoll)
					f.history[0] = options.onPoll(structuredClone(f.history[0]!), polls);
			}
			return f.transport(input, init);
		}) as typeof fetch,
	});
	const client = createLiveClient(api, f.session, f.journal, {
		intervalMs: 250,
		timeoutMs: 1000,
		now: () => time,
		wait: async (ms) => {
			time += ms;
		},
		...options.settlement,
	});
	const store = new ReviewStore(client);
	return { ...f, api, client, store, requests, polls: () => polls };
}
const posts = (f: ReturnType<typeof fixture>) =>
	f.requests.filter((r) => r.method === "POST");
const queueReads = (f: ReturnType<typeof fixture>) =>
	f.requests.filter((r) => r.url.includes("/api/queue?")).length;

test("confirmed PENDING keeps the journal and lock until matching COMPLETE without another POST", async () => {
	const pause = gate();
	const f = fixture({ settlement: { wait: pause.wait } });
	await f.store.load();
	const before = queueReads(f);
	const command = f.store.decide("KEEP");
	await pause.started;
	try {
		expect(f.store.getSnapshot().busy).toBe(true);
		expect(f.store.getSnapshot().queue).toHaveLength(2);
		expect(f.store.getSnapshot().history).toHaveLength(0);
		expect(f.store.getSnapshot().noticeUndoId).toBeNull();
		expect(f.journal.read()?.kind).toBe("decide");
		expect(queueReads(f)).toBe(before);
		await f.store.decide("UNLIKE");
		expect(posts(f)).toHaveLength(1);
	} finally {
		pause.release();
	}
	await command;
	expect(f.store.getSnapshot().error).toBeNull();
	expect(f.store.getSnapshot().history[0]?.result.status).toBe("COMPLETE");
	expect(f.store.getSnapshot().queue).toHaveLength(1);
	expect(f.journal.read()).toBeNull();
	expect(posts(f)).toHaveLength(1);
});

test.each(["409", "pending"] as const)(
	"accepted Undo (%s) waits across COMPLETE until UNDONE with the original decision key",
	async (undoResponse) => {
		const pause = gate();
		const f = fixture({
			pendingDecision: false,
			undoResponse,
			settlement: { wait: pause.wait },
		});
		await f.store.load();
		await f.store.decide("ARCHIVE");
		const original = f.store.getSnapshot().history[0]!.result;
		const before = queueReads(f);
		const command = f.store.undo(original.decisionId);
		await pause.started;
		try {
			expect(f.store.getSnapshot().busy).toBe(true);
			expect(f.store.getSnapshot().history[0]!.result.labelState).toBe(
				"active",
			);
			expect(f.journal.read()?.request.idempotencyKey).not.toBe(
				original.idempotencyKey,
			);
			expect(queueReads(f)).toBe(before);
		} finally {
			pause.release();
		}
		await command;
		expect(f.store.getSnapshot().error).toBeNull();
		expect(f.store.getSnapshot().history[0]!.result).toMatchObject({
			status: "UNDONE",
			idempotencyKey: original.idempotencyKey,
			label: null,
		});
		expect(f.journal.read()).toBeNull();
		expect(posts(f)).toHaveLength(2);
	},
);

test.each(["decide", "undo"] as const)(
	"%s polling timeout preserves the original command and requires explicit recovery",
	async (kind) => {
		const f = fixture({
			pendingDecision: kind === "decide",
			settleAfter: Infinity,
		});
		await f.store.load();
		await f.store.decide("SKIP");
		if (kind === "undo")
			await f.store.undo(f.store.getSnapshot().history[0]!.result.decisionId);
		const pending = f.journal.read();
		expect(pending?.kind).toBe(kind);
		expect(f.store.getSnapshot().retry?.request.idempotencyKey).toBe(
			pending?.request.idempotencyKey,
		);
		expect(f.store.getSnapshot().error).toContain("still settling");
		expect(f.store.getSnapshot().terminal).toBe(false);
		expect(f.store.getSnapshot().busy).toBe(false);
		expect(f.polls()).toBeGreaterThan(0);
		expect(f.polls()).toBeLessThanOrEqual(4);
		expect(posts(f)).toHaveLength(kind === "decide" ? 1 : 2);
		await f.store.decide("KEEP");
		expect(posts(f)).toHaveLength(kind === "decide" ? 1 : 2);
	},
);

test("a terminal history result stops polling without clearing the journal or publishing success", async () => {
	const f = fixture({
		onPoll: (result) => ({
			...result,
			status: "FAILED_TERMINAL",
			mutationStep: "RECONCILING",
			label: null,
			labelState: "inactive",
			canUndo: false,
			error: {
				code: "RECONNECT_REQUIRED",
				message: "Reconnect before continuing.",
				retryable: false,
			},
		}),
	});
	await f.store.load();
	await f.store.decide("UNLIKE");
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().terminal).toBe(true);
	expect(f.journal.read()).not.toBeNull();
	expect(f.store.getSnapshot().queue).toHaveLength(2);
	expect(f.store.getSnapshot().notice).toBe("");
	expect(queueReads(f)).toBe(1);
});

test.each([
	"trackId",
	"exposureId",
	"action",
	"idempotencyKey",
	"decisionId",
] as const)("a polled mismatched %s is never applied", async (field) => {
	const f = fixture({
		settleAfter: 1,
		onPoll: (result) => ({
			...result,
			[field]:
				field === "trackId"
					? "9".repeat(22)
					: field === "action"
						? "KEEP"
						: crypto.randomUUID(),
			...(field === "action"
				? { label: 0, labelState: "active" as const }
				: {}),
		}),
	});
	await f.store.load();
	await f.store.decide("SKIP");
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().error).toBeTruthy();
	expect(f.store.getSnapshot().queue).toHaveLength(2);
	expect(f.journal.read()).not.toBeNull();
	expect(f.store.getSnapshot().notice).toBe("");
	expect(queueReads(f)).toBe(1);
});

test("an owner change during history read stops before the result is applied", async () => {
	const f = fixture({
		settleAfter: 1,
		onPoll: (result) => {
			f.session.user!.id = "other-owner";
			return result;
		},
	});
	await f.store.load();
	await f.store.decide("KEEP");
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().error).toContain("account changed");
	expect(f.store.getSnapshot().queue).toHaveLength(2);
	expect(f.journal.read()).not.toBeNull();
	expect(queueReads(f)).toBe(1);
});

test("an ambiguous POST transport failure does not start automatic reconciliation", async () => {
	const f = fixture({ transportError: true });
	await f.store.load();
	const reads = f.requests.length;
	await f.store.decide("KEEP");
	expect(f.polls()).toBe(0);
	expect(
		f.requests.slice(reads).filter((r) => r.url.endsWith("/history")),
	).toHaveLength(0);
	expect(f.journal.read()).not.toBeNull();
	expect(posts(f)).toHaveLength(1);
});

test.each(["KEEP", "ARCHIVE", "SKIP", "UNLIKE"] as const)(
	"confirmed PENDING %s settles with its actual action semantics",
	async (action) => {
		const f = fixture();
		await f.store.load();
		await f.store.decide(action);
		const result = f.store.getSnapshot().history[0]?.result;
		expect(f.store.getSnapshot().error).toBeNull();
		expect(result?.status).toBe("COMPLETE");
		expect(result?.action).toBe(action);
		expect(result?.label).toBe(
			action === "SKIP" ? null : action === "KEEP" ? 0 : 1,
		);
		expect(result?.liked).toBe(action === "KEEP" || action === "SKIP");
		expect(f.journal.read()).toBeNull();
		expect(posts(f)).toHaveLength(1);
	},
);

test.each(["/api/me", "/api/decisions/history"])(
	"a stalled %s respects the total deadline and cannot apply a late result",
	async (path) => {
		const blocked = gate();
		const f = fixture({
			settleAfter: 1,
			settlement: {
				intervalMs: 1,
				timeoutMs: 20,
				now: Date.now,
				wait: async () => {},
			},
			beforeRead: async (url) => {
				if (url.endsWith(path)) await blocked.wait();
			},
		});
		await f.store.load();
		const command = f.store.decide("KEEP");
		await blocked.started;
		await command;
		const count = f.requests.length;
		expect(f.store.getSnapshot().busy).toBe(false);
		expect(f.store.getSnapshot().error).toContain("still settling");
		expect(f.journal.read()).not.toBeNull();
		blocked.release();
		await Bun.sleep(5);
		expect(f.requests).toHaveLength(count);
		expect(f.store.getSnapshot().queue).toHaveLength(2);
		expect(f.store.getSnapshot().notice).toBe("");
		expect(f.journal.read()).not.toBeNull();
	},
);

test("pending Undo rejects a different original exposure without clearing its own command key", async () => {
	const f = fixture({
		pendingDecision: false,
		settleAfter: 1,
		onPoll: (result) => ({ ...result, exposureId: crypto.randomUUID() }),
	});
	await f.store.load();
	await f.store.decide("KEEP");
	const original = f.store.getSnapshot().history[0]!.result;
	await f.store.undo(original.decisionId);
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().error).toContain("did not match");
	expect(f.store.getSnapshot().history[0]!.result.status).toBe("COMPLETE");
	expect(f.journal.read()?.kind).toBe("undo");
	expect(f.journal.read()?.request.idempotencyKey).not.toBe(
		original.idempotencyKey,
	);
	expect(posts(f)).toHaveLength(2);
});

test("an unreadable history response stops immediately without applying an accepted command", async () => {
	const f = fixture({
		onPoll: (result) => ({
			...result,
			status: "UNKNOWN" as ReviewResult["status"],
		}),
	});
	await f.store.load();
	await f.store.decide("KEEP");
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().error).toContain("shared contract");
	expect(f.journal.read()).not.toBeNull();
	expect(queueReads(f)).toBe(1);
});

test("a history transport failure after accepted PENDING is not silently retried", async () => {
	const f = fixture({
		onPoll: () => {
			throw new TypeError("Authored read failure");
		},
	});
	await f.store.load();
	await f.store.decide("KEEP");
	expect(f.polls()).toBe(1);
	expect(f.store.getSnapshot().error).toContain("read failure");
	expect(f.journal.read()).not.toBeNull();
	expect(queueReads(f)).toBe(1);
});

test("a confirmed pending response with a terminal error does not begin polling", async () => {
	const f = fixture({
		pendingError: {
			code: "RECONNECT_REQUIRED",
			message: "Reconnect before continuing.",
			retryable: false,
		},
	});
	await f.store.load();
	await f.store.decide("KEEP");
	expect(f.polls()).toBe(0);
	expect(f.store.getSnapshot().terminal).toBe(true);
	expect(f.journal.read()).not.toBeNull();
	expect(queueReads(f)).toBe(1);
});

test.each([
	[409, "BATCH_TRACK_RESERVED"],
	[501, "NOT_IMPLEMENTED"],
] as const)(
	"a history %s %s after acceptance cannot discard the decision journal",
	async (status, code) => {
		const { ApiError } = await import("@sortfm/contracts/client");
		const f = fixture({
			onPoll: () => {
				throw new ApiError(status, {
					code,
					message: "Authored read rejection",
					retryable: false,
				});
			},
		});
		await f.store.load();
		await f.store.decide("KEEP");
		expect(f.polls()).toBe(1);
		expect(f.journal.read()?.kind).toBe("decide");
		expect(f.store.getSnapshot().retry?.kind).toBe("decide");
		expect(f.store.getSnapshot().queue).toHaveLength(2);
		expect(queueReads(f)).toBe(1);
		expect(posts(f)).toHaveLength(1);
	},
);

test("a pending Undo terminal error stops before further history reads", async () => {
	const f = fixture({
		pendingDecision: false,
		undoResponse: "pending",
		pendingError: {
			code: "RECONNECT_REQUIRED",
			message: "Reconnect before continuing.",
			retryable: false,
		},
	});
	await f.store.load();
	await f.store.decide("KEEP");
	await f.store.undo(f.store.getSnapshot().history[0]!.result.decisionId);
	expect(f.polls()).toBe(0);
	expect(f.store.getSnapshot().terminal).toBe(true);
	expect(f.journal.read()?.kind).toBe("undo");
	expect(f.store.getSnapshot().history[0]?.result.status).toBe("COMPLETE");
});

test.each(["/api/me", "/api/decisions/history"])(
	"a late retryable %s failure cannot restart reads after the deadline",
	async (path) => {
		const { ApiError } = await import("@sortfm/contracts/client");
		const blocked = gate();
		const f = fixture({
			settlement: {
				intervalMs: 1,
				timeoutMs: 20,
				now: Date.now,
				wait: async () => {},
			},
			beforeRead: async (url) => {
				if (url.endsWith(path)) {
					await blocked.wait();
					throw new ApiError(503, {
						code: "TEMPORARY_READ_FAILURE",
						message: "Read failed",
						retryable: true,
					});
				}
			},
		});
		await f.store.load();
		const command = f.store.decide("KEEP");
		await blocked.started;
		await command;
		const count = f.requests.length;
		blocked.release();
		await Bun.sleep(5);
		expect(f.requests).toHaveLength(count);
		expect(f.journal.read()).not.toBeNull();
		expect(f.store.getSnapshot().history).toHaveLength(0);
	},
);
