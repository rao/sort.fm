import { expect, test } from "bun:test";
import {
	calibrationJournal,
	createCalibrationClient,
} from "../data/calibration-client";
import { calibrationExperimentFixture } from "../test-support/calibration-experiment-fixture";
import { CalibrationStore, calibrationLocked } from "./calibration";

function setup() {
	const f = calibrationExperimentFixture();
	const journal = calibrationJournal(f.storage, "owner");
	const client = createCalibrationClient(f.api, f.session, journal);
	return { ...f, journal, client, store: new CalibrationStore(client) };
}
const posts = (f: ReturnType<typeof setup>) =>
	f.calls.filter((c) => c.init?.method === "POST");

test.each(["reserved", "absent"] as const)(
	"Batch3 %s hides all songs/history and blocks every write, including keyboard actions",
	async (phase) => {
		const f = setup();
		await f.store.load();
		await f.store.label(0);
		const labelId = f.history[0]!.labelId;
		f.setPhase(phase);
		const before = f.calls.length;
		await f.store.selectSession("batch3");
		expect(f.store.getSnapshot().session).toBe("batch3");
		expect(calibrationLocked(f.store.getSnapshot())).toBe(true);
		expect(f.store.getSnapshot().queue).toEqual([]);
		expect(f.store.getSnapshot().history).toEqual([]);
		expect(f.store.getSnapshot().tracks).toEqual({});
		expect(f.store.getSnapshot().metrics).toBeNull();
		await f.store.label(1);
		await f.store.skip();
		await f.store.undo(labelId);
		await f.store.retrain();
		expect(f.calls.slice(before).every((c) => c.init?.method !== "POST")).toBe(
			true,
		);
		expect(
			f.calls
				.slice(before)
				.some((c) => /history|insights|calibration\/queue/.test(c.url)),
		).toBe(false);
		expect(f.journal.readSession!()).toBe("batch3");
	},
);

test("Batch3 ready resumes through GET, supports label and Undo, keeps predictions out of model state", async () => {
	const f = setup();
	f.setPhase("ready");
	await f.store.selectSession("batch3");
	expect(posts(f)).toHaveLength(0);
	expect(f.store.getSnapshot().experiment?.phase).toBe("ready");
	expect(f.store.getSnapshot().queue).toHaveLength(60);
	expect(f.store.getSnapshot().metrics).toBeNull();
	await f.store.label(0);
	expect(f.store.getSnapshot().queue).toHaveLength(59);
	expect(f.store.getSnapshot().tracks[f.history[0]!.trackId]?.title).toBe(
		"Private batch song 0",
	);
	await f.store.undo(f.history[0]!.labelId);
	expect(f.store.getSnapshot().queue).toHaveLength(60);
	expect(f.history[0]!.state).toBe("revoked");
	await f.store.retrain();
	expect(posts(f)).toHaveLength(2);
	expect(posts(f).every((c) => c.url.includes("/calibration/labels"))).toBe(
		true,
	);
});

test("Batch3 evaluation Skip permanently removes the card without replacement, even after lost response and reload", async () => {
	const f = setup();
	f.setPhase("ready");
	await f.store.selectSession("batch3");
	const first = f.store.getSnapshot().queue[0]!;
	f.loseSkip();
	await f.store.skip();
	const key = f.journal.read()!.request.idempotencyKey;
	expect(f.journal.read()?.kind).toBe("skip");
	expect(f.storage.getItem("sortfm:calibration:pending:v1:owner")).toBeNull();
	expect(
		f.storage.getItem("sortfm:calibration:batch3:pending:v1:owner"),
	).toContain(key);
	const reloaded = new CalibrationStore(
		createCalibrationClient(
			f.api,
			f.session,
			calibrationJournal(f.storage, "owner"),
		),
	);
	await reloaded.load();
	expect(reloaded.getSnapshot().session).toBe("batch3");
	expect(reloaded.getSnapshot().pending).toBeNull();
	expect(reloaded.getSnapshot().queue).toHaveLength(59);
	expect(
		reloaded
			.getSnapshot()
			.queue.some((i) => i.track.trackId === first.track.trackId),
	).toBe(false);
	expect(f.skipCount()).toBe(1);
	expect(posts(f)).toHaveLength(1);
	expect(f.history).toHaveLength(0);
	expect(reloaded.getSnapshot().notice).not.toContain("replacement");
});

test("ambiguous Batch3 label preserves its namespace and key through failed refresh and blocks mode switching", async () => {
	const f = setup();
	f.setPhase("ready");
	await f.store.selectSession("batch3");
	f.loseResponse();
	await f.store.label(1);
	const original = f.journal.read();
	await f.store.selectSession("batch2");
	await f.store.selectSession("ordinary");
	expect(f.journal.read()).toEqual(original);
	expect(f.store.getSnapshot().session).toBe("batch3");
	f.failRead(true);
	const reloaded = new CalibrationStore(
		createCalibrationClient(
			f.api,
			f.session,
			calibrationJournal(f.storage, "owner"),
		),
	);
	await reloaded.load();
	expect(reloaded.getSnapshot().pending).toEqual(original);
	await reloaded.label(0);
	await reloaded.skip();
	expect(posts(f)).toHaveLength(1);
	f.failRead(false);
	await reloaded.refresh();
	expect(reloaded.getSnapshot().pending).toBeNull();
	expect(f.history).toHaveLength(1);
	expect(posts(f)).toHaveLength(1);
});

test("pending ordinary action cannot be stranded by switching into Batch3", async () => {
	const f = setup();
	await f.store.load();
	f.loseResponse();
	await f.store.label(0);
	const original = f.journal.read();
	await f.store.selectSession("batch3");
	expect(f.store.getSnapshot().session).toBe("ordinary");
	expect(f.journal.read()).toEqual(original);
	expect(
		f.storage.getItem("sortfm:calibration:batch3:pending:v1:owner"),
	).toBeNull();
});

test("reserved snapshots hide previously ready cards and preserve pending commands without replay", async () => {
	const f = setup();
	f.setPhase("ready");
	await f.store.selectSession("batch3");
	f.loseResponse();
	await f.store.label(1);
	const pending = f.journal.read();
	f.setPhase("reserved");
	await f.store.refresh();
	expect(f.store.getSnapshot().tracks).toEqual({});
	expect(f.store.getSnapshot().history).toEqual([]);
	expect(f.store.getSnapshot().queue).toEqual([]);
	await f.store.retry();
	await f.store.label(0);
	await f.store.skip();
	await f.store.retrain();
	expect(posts(f)).toHaveLength(1);
	expect(f.journal.read()).toEqual(pending);
});

test("Batch3 read failure cannot expose an ordinary queue and resumes with GET only", async () => {
	const f = setup();
	await f.store.load();
	f.failRead(true);
	await f.store.selectSession("batch3");
	expect(f.store.getSnapshot().queue).toEqual([]);
	expect(f.store.getSnapshot().tracks).toEqual({});
	expect(f.store.getSnapshot().refreshError).toBeTruthy();
	await f.store.label(0);
	await f.store.skip();
	expect(posts(f)).toHaveLength(0);
	f.failRead(false);
	f.setPhase("ready");
	await f.store.refresh();
	expect(f.store.getSnapshot().queue).toHaveLength(60);
	expect(posts(f)).toHaveLength(0);
});

test("mode switches cannot race a pending Batch3 label", async () => {
	const f = setup();
	f.setPhase("ready");
	await f.store.selectSession("batch3");
	const label = f.client.label;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.client.label = async (request) => {
		await gate;
		return label(request);
	};
	const write = f.store.label(0);
	await f.store.selectSession("ordinary");
	await f.store.selectSession("batch2");
	expect(f.store.getSnapshot().session).toBe("batch3");
	expect(f.journal.readSession!()).toBe("batch3");
	expect(f.journal.read()?.kind).toBe("label");
	release();
	await write;
	expect(f.journal.read()).toBeNull();
	expect(f.history).toHaveLength(1);
});

test("Batch3 training Skip adopts only the replacement returned by the server", async () => {
	const f = setup();
	f.setPhase("ready");
	f.ready.queue.items.unshift(f.ready.queue.items.splice(40, 1)[0]!);
	await f.store.selectSession("batch3");
	const original = f.store.getSnapshot().queue[0]!;
	await f.store.skip();
	const state = f.store.getSnapshot();
	expect(state.queue).toHaveLength(60);
	expect(
		state.queue.some((item) => item.track.trackId === original.track.trackId),
	).toBe(false);
	expect(
		state.queue.some((item) => item.track.trackId === "0000000000000000000201"),
	).toBe(true);
	expect(f.history).toHaveLength(0);
	expect(posts(f)).toHaveLength(1);
	expect(posts(f)[0]!.url).toBe(
		"/api/calibration/experiments/calibration-batch3-v1/skip",
	);
});
