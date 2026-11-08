import { expect, test } from "bun:test";
import { createIdempotencyKey } from "@sortfm/contracts/client";
import type { CalibrationLabelResult, ReviewResult } from "@sortfm/contracts";
import { liveFixture } from "../test-support/live-fixture";
import { createLiveApi } from "../data/live-client";
import {
	correctionJournal,
	createCorrectionClient,
} from "../data/correction-client";
import { CorrectionStore } from "./corrections";

async function setup() {
	const f = liveFixture();
	const original = f.items[0]!;
	const decision = await f.client.decide({
		trackId: original.track.trackId,
		exposureId: original.exposure.exposureId,
		action: "SKIP",
		idempotencyKey: createIdempotencyKey(),
	});
	const labels: CalibrationLabelResult[] = [];
	const calls: { url: string; body: unknown; method: string }[] = [];
	let loseResponse = false;
	let historyFails = false;
	let rejection: string | null = null;
	let rejectionStatus = 409;
	const transport = (async (input, init) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ url, body, method: init?.method ?? "GET" });
		if (url.endsWith("/api/me")) return Response.json(f.session);
		if (url.endsWith("/api/calibration/history"))
			return historyFails
				? Response.json(
						{
							code: "OFFLINE",
							message: "History unavailable",
							retryable: true,
						},
						{ status: 503 },
					)
				: Response.json({ items: labels, nextCursor: null });
		if (url.endsWith("/api/calibration/corrections")) {
			if (rejection)
				return Response.json(
					{ code: rejection, message: "Correction rejected", retryable: false },
					{ status: rejectionStatus },
				);
			let result = labels.find(
				(label) => label.idempotencyKey === body.idempotencyKey,
			);
			if (!result) {
				const at = new Date().toISOString();
				result = {
					mode: "calibration",
					labelId: crypto.randomUUID(),
					trackId: decision.trackId,
					exposureId: crypto.randomUUID(),
					idempotencyKey: body.idempotencyKey,
					submittedLabel: 1,
					label: 1,
					state: "active",
					canUndo: true,
					feedbackRevision: 1,
					createdAt: at,
					updatedAt: at,
				};
				labels.unshift(result);
			}
			if (loseResponse) {
				loseResponse = false;
				throw new TypeError("Response lost");
			}
			return Response.json(result);
		}
		if (url.endsWith("/undo")) {
			const result = labels.find(
				(label) => label.labelId === url.split("/").at(-2),
			)!;
			Object.assign(result, {
				label: null,
				state: "revoked",
				canUndo: false,
				feedbackRevision: 2,
			});
			if (loseResponse) {
				loseResponse = false;
				throw new TypeError("Response lost");
			}
			return Response.json(result);
		}
		throw new Error(`Forbidden correction route: ${url}`);
	}) as typeof fetch;
	const journal = correctionJournal(f.storage, "owner");
	const client = createCorrectionClient(
		createLiveApi({ fetch: transport }),
		f.session,
		journal,
	);
	const store = new CorrectionStore(client);
	await store.load();
	return {
		...f,
		decision,
		labels,
		calls,
		journal,
		client,
		store,
		transport,
		loseResponse: () => {
			loseResponse = true;
		},
		failHistory: (value: boolean) => {
			historyFails = value;
		},
		reject: (code: string, status = 409) => {
			rejection = code;
			rejectionStatus = status;
		},
	};
}
const posts = (f: Awaited<ReturnType<typeof setup>>) =>
	f.calls.filter((call) => call.method === "POST");

test("authoritative missing-decision rejection clears only a fresh correction", async () => {
	const f = await setup();
	f.reject("DECISION_NOT_FOUND", 404);
	await f.store.correct(f.decision);
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().pending).toBeNull();
	expect(f.store.getSnapshot().error).toContain("not accepted");
});

test("failed journal clear preserves recovery after a confirmed label", async () => {
	const f = await setup();
	const store = new CorrectionStore({
		...f.client,
		journal: {
			...f.journal,
			clear: () => {
				throw new Error("Storage blocked");
			},
		},
	});
	await store.load();
	await store.correct(f.decision);
	expect(f.labels).toHaveLength(1);
	expect(f.journal.read()).not.toBeNull();
	expect(store.getSnapshot().pending).not.toBeNull();
	expect(store.getSnapshot().notice).toBe("");
	await store.correct(f.decision);
	expect(posts(f)).toHaveLength(1);
});

test("one explicit correction submits the exact original Skip and leaves review history unchanged", async () => {
	const f = await setup();
	const before = structuredClone(f.history);
	await Promise.all([f.store.correct(f.decision), f.store.correct(f.decision)]);
	expect(posts(f)).toHaveLength(1);
	expect(posts(f)[0]!.body).toEqual({
		decisionId: f.decision.decisionId,
		idempotencyKey: f.labels[0]!.idempotencyKey,
		label: 1,
	});
	expect(f.history).toEqual(before);
	expect(f.store.getSnapshot().labels[0]!.label).toBe(1);
	expect(f.store.getSnapshot().pending).toBeNull();
	expect(f.journal.read()).toBeNull();
	expect(
		f.calls.some((call) =>
			/\/api\/(decisions|queue|player|library)/.test(call.url),
		),
	).toBe(false);
});

test("an ambiguous correction reload reconciles from calibration history without another POST", async () => {
	const f = await setup();
	f.loseResponse();
	await f.store.correct(f.decision);
	const pending = f.journal.read();
	expect(pending?.kind).toBe("correct");
	const reloaded = new CorrectionStore(f.client);
	await reloaded.load();
	expect(reloaded.getSnapshot().pending).toBeNull();
	expect(f.journal.read()).toBeNull();
	expect(posts(f)).toHaveLength(1);
});

test("ambiguous retry preserves the original key when history is unavailable", async () => {
	const f = await setup();
	f.loseResponse();
	await f.store.correct(f.decision);
	const key = f.journal.read()!.request.idempotencyKey;
	f.failHistory(true);
	const reloaded = new CorrectionStore(f.client);
	await reloaded.load();
	expect(posts(f)).toHaveLength(1);
	f.failHistory(false);
	await reloaded.retry();
	expect(
		posts(f).map(
			(call) => (call.body as { idempotencyKey: string }).idempotencyKey,
		),
	).toEqual([key, key]);
	expect(f.labels).toHaveLength(1);
});

test("Undo revokes only the preference label and preserves the original Skip", async () => {
	const f = await setup();
	await f.store.correct(f.decision);
	f.loseResponse();
	await f.store.undo(f.labels[0]!.labelId);
	expect(f.journal.read()?.kind).toBe("undo");
	await f.store.refresh();
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().labels[0]!.state).toBe("revoked");
	expect(f.history[0]!.action).toBe("SKIP");
	expect(f.history[0]!.status).toBe("COMPLETE");
	expect(f.history[0]!.label).toBeNull();
	expect(posts(f)).toHaveLength(2);
});

test("changed owners and failed journal writes prevent correction POSTs", async () => {
	const f = await setup();
	f.session.user!.id = "other";
	await f.store.correct(f.decision);
	expect(posts(f)).toHaveLength(0);
	expect(correctionJournal(f.storage, "other").read()).toBeNull();
	const g = await setup();
	const store = new CorrectionStore({
		...g.client,
		journal: {
			...g.journal,
			write: () => {
				throw new Error("Storage blocked");
			},
		},
	});
	await store.load();
	await store.correct(g.decision);
	expect(posts(g)).toHaveLength(0);
});

test.each(["KEEP", "UNDONE", "demo"])(
	"ineligible local review state %s never creates a correction",
	async (value) => {
		const f = await setup();
		const decision: ReviewResult = {
			...f.decision,
			...(value === "KEEP"
				? { action: "KEEP", label: 0 }
				: value === "UNDONE"
					? { status: "UNDONE" }
					: { mode: "demo" }),
		};
		await f.store.correct(decision);
		expect(posts(f)).toHaveLength(0);
	},
);

test.each([
	"CALIBRATION_NOT_ELIGIBLE",
	"BATCH_TRACK_RESERVED",
	"MUTATION_PENDING",
	"CALIBRATION_LABEL_ACTIVE",
])(
	"first-attempt %s rejection clears only its unaccepted correction",
	async (code) => {
		const f = await setup();
		f.reject(code);
		await f.store.correct(f.decision);
		expect(f.journal.read()).toBeNull();
		expect(f.store.getSnapshot().pending).toBeNull();
		expect(f.store.getSnapshot().error).toContain("not accepted");
		expect(f.labels).toHaveLength(0);
	},
);

test.each(["CALIBRATION_NOT_ELIGIBLE", "IDEMPOTENCY_CONFLICT"])(
	"recovery %s cannot discard an earlier ambiguous correction",
	async (code) => {
		const f = await setup();
		f.loseResponse();
		await f.store.correct(f.decision);
		const pending = f.journal.read();
		f.reject(code);
		await f.store.retry();
		expect(f.journal.read()).toEqual(pending);
		expect(f.store.getSnapshot().pending).toEqual(pending);
		expect(f.labels).toHaveLength(1);
	},
);

test("a response for another track remains pending instead of advertising success", async () => {
	const f = await setup();
	const store = new CorrectionStore({
		...f.client,
		correct: async (request) => ({
			...(await f.client.correct(request)),
			trackId: "z".repeat(22),
		}),
	});
	await store.load();
	await store.correct(f.decision);
	expect(store.getSnapshot().notice).toBe("");
	expect(store.getSnapshot().pending).not.toBeNull();
	expect(f.journal.read()).not.toBeNull();
});
