import { expect, test } from "bun:test";
import { ApiError } from "@sortfm/contracts/client";
import { calibrationFixture } from "../test-support/calibration-fixture";
import {
	calibrationJournal,
	createCalibrationClient,
} from "../data/calibration-client";
import {
	CalibrationStore,
	calibrationActionFromKey,
	calibrationActionFromDrag,
} from "./calibration";
function setup() {
	const f = calibrationFixture();
	const journal = calibrationJournal(f.storage, f.session.user!.id);
	const client = createCalibrationClient(f.api, f.session, journal);
	const store = new CalibrationStore(client);
	return { ...f, journal, client, store };
}
const posts = (f: ReturnType<typeof setup>) =>
	f.calls.filter((c) => c.init?.method === "POST");
test("calibration labels both classes, skips locally, and undoes without cleanup routes", async () => {
	const f = setup();
	await f.store.load();
	const calls = f.calls.length;
	f.store.skip();
	expect(f.calls.length).toBe(calls);
	await f.store.label(1);
	await f.store.showSkipped();
	await f.store.label(0);
	expect(f.history.map((h) => h.submittedLabel).sort()).toEqual([0, 1]);
	await f.store.undo(f.history[0]!.labelId);
	expect(f.history[0]!.state).toBe("revoked");
	expect(f.store.getSnapshot().error).toBeNull();
	expect(posts(f)).toHaveLength(3);
	expect(
		f.calls.every((c) => /\/api\/(me|calibration\/|ml\/insights)/.test(c.url)),
	).toBe(true);
	expect(f.calls.every((c) => c.init?.credentials === "include")).toBe(true);
});
test("response loss reload resolves by original key from history without another POST", async () => {
	const f = setup();
	await f.store.load();
	f.loseResponse();
	await f.store.label(0);
	const pending = f.journal.read();
	expect(pending?.kind).toBe("label");
	const reloaded = new CalibrationStore(f.client);
	await reloaded.load();
	expect(f.journal.read()).toBeNull();
	expect(reloaded.getSnapshot().pending).toBeNull();
	expect(reloaded.getSnapshot().history[0]?.state).toBe("active");
	expect(posts(f)).toHaveLength(1);
});
test("ambiguous request can retry same key; history outage cannot trigger automatic writes", async () => {
	const f = setup();
	await f.store.load();
	f.loseResponse();
	await f.store.label(1);
	const key = f.journal.read()!.request.idempotencyKey;
	f.failHistory(true);
	const reloaded = new CalibrationStore(f.client);
	await reloaded.load();
	expect(posts(f)).toHaveLength(1);
	expect(reloaded.getSnapshot().pending?.request.idempotencyKey).toBe(key);
	f.failHistory(false);
	await reloaded.retry();
	expect(
		posts(f).map((c) => JSON.parse(String(c.init?.body)).idempotencyKey),
	).toEqual([key, key]);
	expect(f.history).toHaveLength(1);
});
test("lost Undo response recovers through calibration history and revoked labels never count as active", async () => {
	const f = setup();
	await f.store.load();
	await f.store.label(0);
	f.loseResponse();
	await f.store.undo(f.history[0]!.labelId);
	expect(f.journal.read()?.kind).toBe("undo");
	await f.store.refresh();
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().history[0]?.state).toBe("revoked");
	expect(posts(f)).toHaveLength(2);
});
test("post-label refresh failure blocks new commands and recovers with reads only", async () => {
	const f = setup();
	await f.store.load();
	f.failQueue(true);
	await f.store.label(0);
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().refreshError).toBeTruthy();
	await f.store.label(1);
	expect(posts(f)).toHaveLength(1);
	f.failQueue(false);
	await f.store.refresh();
	expect(f.store.getSnapshot().refreshError).toBeNull();
	expect(posts(f)).toHaveLength(1);
});
test("unavailable calibration routes fail closed and never construct review commands", async () => {
	const f = setup();
	f.unavailable(true);
	await f.store.load();
	await f.store.label(0);
	f.store.skip();
	expect(f.store.getSnapshot().ready).toBe(false);
	expect(f.store.getSnapshot().error).toBeTruthy();
	expect(posts(f)).toHaveLength(0);
});
test("changed owners and storage failure block writes; calibration journal is separate", async () => {
	const f = setup();
	await f.store.load();
	f.session.user!.id = "other";
	await f.store.label(0);
	expect(posts(f)).toHaveLength(0);
	expect(calibrationJournal(f.storage, "other").read()).toBeNull();
	expect(f.storage.getItem("sortfm:pending:v1:owner")).toBeNull();
	const g = setup();
	const broken = createCalibrationClient(g.api, g.session, {
		...g.journal,
		write: () => {
			throw new Error("Storage unavailable");
		},
	});
	const store = new CalibrationStore(broken);
	await store.load();
	await store.label(0);
	expect(posts(g)).toHaveLength(0);
});
test("retrain uses confirmed personal counts and keeps pending-label recovery isolated", async () => {
	const f = setup();
	await f.store.load();
	await f.store.label(0);
	await f.store.label(1);
	await f.store.retrain();
	expect(f.store.getSnapshot().metrics?.labeledExamples).toBe(2);
	expect(f.store.getSnapshot().metrics?.modelVersion).toBe("fit-2");
	f.failFit(true);
	await f.store.retrain();
	const n = posts(f).length;
	await f.store.retrain();
	expect(posts(f)).toHaveLength(n);
	expect(f.store.getSnapshot().retrainError).toBeTruthy();
	await f.store.refresh();
	expect(f.store.getSnapshot().retrainError).toBeNull();
});
test("keyboard and drag mapping have no destructive down action", () => {
	expect(
		["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "z"].map(
			calibrationActionFromKey,
		),
	).toEqual([0, 1, "skip", null, "undo"]);
	expect(calibrationActionFromDrag(100, 0)).toBe(0);
	expect(calibrationActionFromDrag(-100, 0)).toBe(1);
	expect(calibrationActionFromDrag(0, -100)).toBe("skip");
	expect(calibrationActionFromDrag(0, 100)).toBeNull();
});

test("duplicate label attempts serialize and retain the served exposure in retries", async () => {
	const f = calibrationFixture();
	let release!: () => void;
	let entered!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const { createLiveApi } = await import("../data/live-client");
	const api = createLiveApi({
		fetch: (async (input, init) => {
			if (String(input).endsWith("/calibration/labels")) {
				entered();
				await held;
			}
			return f.transport(input, init);
		}) as typeof fetch,
	});
	const journal = calibrationJournal(f.storage, "owner");
	const store = new CalibrationStore(
		createCalibrationClient(api, f.session, journal),
	);
	await store.load();
	const exposure = store.getSnapshot().queue[0]!.exposure.exposureId;
	const pending = store.label(0);
	await started;
	await store.label(1);
	store.skip();
	await store.retrain();
	expect(store.getSnapshot().busy).toBe(true);
	expect(journal.read()?.kind).toBe("label");
	release();
	await pending;
	expect(f.calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
	expect(f.history[0]!.exposureId).toBe(exposure);
});
test("revoked/superseded replay resolves original label without pretending it is still active", async () => {
	for (const state of ["revoked", "superseded"] as const) {
		const f = setup();
		await f.store.load();
		f.loseResponse();
		await f.store.label(1);
		Object.assign(f.history[0]!, { state, label: null, canUndo: false });
		await f.store.refresh();
		expect(f.store.getSnapshot().pending).toBeNull();
		expect(f.store.getSnapshot().history[0]?.state).toBe(state);
		expect(f.store.getSnapshot().notice).toContain(state);
		expect(posts(f)).toHaveLength(1);
	}
});
test("malformed calibration journals fail closed; unavailable and synthetic metrics are never invented", async () => {
	const f = setup();
	f.storage.setItem(
		"sortfm:calibration:pending:v1:owner",
		'{"kind":"decide","request":{}}',
	);
	await f.store.load();
	await f.store.label(0);
	expect(f.store.getSnapshot().ready).toBe(false);
	expect(posts(f)).toHaveLength(0);
	const g = setup();
	const { coldModelMetrics } = await import("../test-support/live-fixture");
	g.setMetrics({ ...coldModelMetrics, labeledExamples: 1 });
	await g.store.load();
	expect(g.store.getSnapshot().metrics).toBeNull();
	expect(g.store.getSnapshot().modelWarning).toContain("Synthetic");
});
test("pending calibration command prevents fit and new labels but retains the exact original request", async () => {
	const f = setup();
	await f.store.load();
	f.loseResponse();
	await f.store.label(0);
	const pending = structuredClone(f.journal.read());
	await f.store.label(1);
	await f.store.retrain();
	f.store.skip();
	expect(f.journal.read()).toEqual(pending);
	expect(posts(f)).toHaveLength(1);
});

test("a known first-attempt rejection clears the journal but requires a fresh selection", async () => {
	const f = setup();
	const label = f.client.label;
	f.client.label = async () => {
		throw new ApiError(409, {
			code: "STALE_EXPOSURE",
			message: "Selection expired",
			retryable: false,
		});
	};
	await f.store.load();
	await f.store.label(0);
	expect(f.journal.read()).toBeNull();
	expect(f.store.getSnapshot().pending).toBeNull();
	expect(f.store.getSnapshot().refreshError).toContain("not accepted");
	f.client.label = label;
	await f.store.label(1);
	expect(posts(f)).toHaveLength(0);
	await f.store.refresh();
	await f.store.label(1);
	expect(f.history).toHaveLength(1);
});
test("known rejections never discard a previously ambiguous command", async () => {
	const f = setup();
	await f.store.load();
	f.loseResponse();
	await f.store.label(0);
	const key = f.journal.read()!.request.idempotencyKey;
	f.client.label = async () => {
		throw new ApiError(409, {
			code: "STALE_EXPOSURE",
			message: "Selection expired",
			retryable: false,
		});
	};
	await f.store.retry();
	expect(f.journal.read()?.request.idempotencyKey).toBe(key);
	expect(f.store.getSnapshot().pending?.request.idempotencyKey).toBe(key);
	await f.store.refresh();
	expect(f.journal.read()).toBeNull();
	expect(posts(f)).toHaveLength(1);
});
test("unknown or idempotency conflicts preserve the recovery journal", async () => {
	for (const code of ["IDEMPOTENCY_CONFLICT", "UNKNOWN_CONFLICT"]) {
		const f = setup();
		f.client.label = async () => {
			throw new ApiError(409, { code, message: "Conflict", retryable: false });
		};
		await f.store.load();
		await f.store.label(0);
		expect(f.journal.read()?.kind).toBe("label");
	}
});
