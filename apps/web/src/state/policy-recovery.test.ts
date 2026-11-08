import { expect, test } from "bun:test";
import type { ReviewRequest, ReviewResult } from "@sortfm/contracts";
import { createLiveApi, createLiveClient } from "../data/live-client";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "./review";

function fixture(
	onDecision: (request: ReviewRequest) => Promise<Response | null>,
) {
	const f = liveFixture();
	const requests: ReviewRequest[] = [];
	const api = createLiveApi({
		fetch: (async (input, init) => {
			if (String(input).endsWith("/api/decisions") && init?.method === "POST") {
				const request = JSON.parse(String(init.body)) as ReviewRequest;
				requests.push(request);
				const response = await onDecision(request);
				if (response) return response;
			}
			return f.transport(input, init);
		}) as typeof fetch,
	});
	const client = createLiveClient(api, f.session, f.journal, {
		timeoutMs: 5,
		intervalMs: 1,
	});
	return { ...f, requests, client, store: new ReviewStore(client) };
}

function closed(status = 409, retryable: boolean | undefined = false) {
	return Response.json(
		{
			code: "POLICY_EXPOSURE_CLOSED",
			message: "This card has expired. Refresh the queue.",
			retryable,
		},
		{ status },
	);
}

test.each(["KEEP", "ARCHIVE", "SKIP", "UNLIKE"] as const)(
	"fresh %s on an expired card clears its journal and GET refreshes without replaying the action",
	async (action) => {
		const freshExposure = crypto.randomUUID();
		const f = fixture(async () => {
			if (f.requests.length > 1) return null;
			f.items[0]!.exposure.exposureId = freshExposure;
			return closed();
		});
		await f.store.load();
		const reads = f.calls.length;
		await f.store.decide(action);
		expect(f.journal.read()).toBeNull();
		expect(f.store.getSnapshot().retry).toBeNull();
		expect(f.store.getSnapshot().terminal).toBe(false);
		expect(f.store.getSnapshot().error).toBeNull();
		expect(f.store.getSnapshot().notice).toBeTruthy();
		expect(f.store.getSnapshot().noticeUndoId).toBeNull();
		expect(f.store.getSnapshot().queue[0]?.exposure.exposureId).toBe(
			freshExposure,
		);
		expect(f.history).toHaveLength(0);
		expect(f.requests).toHaveLength(1);
		expect(f.calls.length).toBeGreaterThan(reads);
		expect(
			f.calls.slice(reads).every((call) => call.init?.method !== "POST"),
		).toBe(true);
		await f.store.decide("KEEP");
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]!.trackId).toBe(f.requests[0]!.trackId);
		expect(f.requests[1]!.exposureId).toBe(freshExposure);
		expect(f.requests[1]!.idempotencyKey).not.toBe(
			f.requests[0]!.idempotencyKey,
		);
		expect(f.history).toHaveLength(1);
	},
);

test("failed refresh after a fresh closed-card rejection pauses new actions without restoring the rejected journal", async () => {
	const f = fixture(async () => {
		f.setQueueError(true);
		return closed();
	});
	await f.store.load();
	await f.store.decide("KEEP");
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().queue).toHaveLength(0);
	expect(f.store.getSnapshot().refreshError).toBeTruthy();
	expect(f.store.getSnapshot().error).toBeNull();
	await f.store.decide("UNLIKE");
	expect(f.requests).toHaveLength(1);
	f.setQueueError(false);
	await f.store.refresh();
	expect(f.store.getSnapshot().queue).toHaveLength(2);
	expect(f.store.getSnapshot().refreshError).toBeNull();
});

test.each([false, true])(
	"closed-card rejection preserves an earlier ambiguous journal (reload=%s)",
	async (reload) => {
		const f = fixture(async () => {
			if (f.requests.length === 1) throw new Error("Response lost");
			return closed();
		});
		await f.store.load();
		await f.store.decide("ARCHIVE");
		const original = f.journal.read()!;
		const store = reload ? new ReviewStore(f.client) : f.store;
		if (reload) await store.load();
		await store.retry();
		expect(f.requests).toHaveLength(2);
		expect(f.requests[1]).toEqual(f.requests[0]);
		expect(f.journal.read()?.request.idempotencyKey).toBe(
			original.request.idempotencyKey,
		);
		expect(store.getSnapshot().retry?.request.idempotencyKey).toBe(
			original.request.idempotencyKey,
		);
		await store.recover();
		expect(f.journal.read()?.request.idempotencyKey).toBe(
			original.request.idempotencyKey,
		);
		await store.decide("UNLIKE");
		expect(f.requests).toHaveLength(2);
	},
);

test.each([
	{ status: 503, retryable: false },
	{ status: 409, retryable: true },
	{ status: 409, retryable: undefined },
])(
	"closed code without exact authoritative rejection preserves recovery: %j",
	async ({ status, retryable }) => {
		const f = fixture(async () =>
			Response.json(
				{ code: "POLICY_EXPOSURE_CLOSED", message: "Closed", retryable },
				{ status },
			),
		);
		await f.store.load();
		await f.store.decide("KEEP");
		expect(f.journal.read()?.request.idempotencyKey).toBe(
			f.requests[0]!.idempotencyKey,
		);
		expect(f.store.getSnapshot().retry).not.toBeNull();
	},
);

test("closed-card rejection cannot discard an accepted pending command restored after reload", async () => {
	const f = fixture(async (request) => {
		if (f.requests.length > 1) return closed();
		const pending: ReviewResult = {
			...request,
			decisionId: crypto.randomUUID(),
			mode: "spotify",
			status: "PENDING",
			mutationStep: "PENDING",
			liked: null,
			archived: null,
			canUndo: false,
			label: null,
			labelState: "inactive",
			feedbackRevision: 0,
			error: null,
			createdAt: "2026-11-07T16:00:00.000Z",
			updatedAt: "2026-11-07T16:00:00.000Z",
		};
		f.history.push(pending);
		return Response.json(pending, { status: 202 });
	});
	await f.store.load();
	await f.store.decide("UNLIKE");
	expect(f.store.getSnapshot().error).toContain("still settling");
	const store = new ReviewStore(f.client);
	await store.load();
	await store.retry();
	expect(f.requests).toHaveLength(2);
	expect(f.requests[1]).toEqual(f.requests[0]);
	await store.recover();
	expect(f.journal.read()?.request.idempotencyKey).toBe(
		f.requests[0]!.idempotencyKey,
	);
	expect(store.getSnapshot().retry).not.toBeNull();
});

test("failure to clear a fresh rejected journal leaves review paused", async () => {
	const f = fixture(async () => closed());
	const client = {
		...f.client,
		live: {
			...f.client.live!,
			journal: {
				...f.journal,
				clear: () => {
					throw new Error("Storage unavailable");
				},
			},
		},
	};
	const store = new ReviewStore(client);
	await store.load();
	await store.decide("KEEP");
	expect(f.journal.read()?.request.idempotencyKey).toBe(
		f.requests[0]!.idempotencyKey,
	);
	expect(store.getSnapshot().terminal).toBe(true);
	expect(store.getSnapshot().retry).not.toBeNull();
	await store.decide("UNLIKE");
	expect(f.requests).toHaveLength(1);
});
