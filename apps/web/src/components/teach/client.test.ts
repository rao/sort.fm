import { createIdempotencyKey } from "@sortfm/contracts/client";
import { expect, test } from "bun:test";
import { calibrationFixture } from "../../test-support/calibration-fixture";
import {
	calibrationJournal,
	createCalibrationClient,
} from "../../data/calibration-client";
import { CalibrationStore } from "../../state/calibration";

function setup() {
	const f = calibrationFixture();
	let failed = false,
		revision = 0;
	const reads = {
		history: async () => ({
			items: structuredClone(f.history),
			nextCursor: null,
		}),
		status: async () => {
			if (failed) throw new Error("private response");
			revision = Math.max(
				revision,
				...f.history.map((h) => h.feedbackRevision),
			);
			return {
				trainingFeedbackCount: f.history.filter((h) => h.state === "active")
					.length,
				feedbackRevision: revision,
				synchronizedFeedbackRevision: 0,
				modelVersion: "c1-fixture",
			};
		},
	};
	const journal = calibrationJournal(f.storage, f.session.user!.id, "teach");
	const client = createCalibrationClient(f.api, f.session, journal, reads);
	return {
		...f,
		client,
		reads,
		journal,
		store: new CalibrationStore(client),
		failStatus: () => {
			failed = true;
		},
	};
}
test("public Teach ignores the saved research session and preserves its pending journal", async () => {
	const f = setup();
	const research = calibrationJournal(f.storage, f.session.user!.id);
	research.selectSession!("batch3");
	const pending = {
		kind: "skip" as const,
		request: {
			exposureId: crypto.randomUUID(),
			idempotencyKey: createIdempotencyKey(),
		},
	};
	research.write(pending, "batch3");
	await f.store.load();
	expect(f.store.getSnapshot().session).toBe("ordinary");
	expect(f.store.getSnapshot().pending).toBeNull();
	expect(research.read("batch3")).toEqual(pending);
	expect(
		f.calls.every(
			(c) =>
				!c.url.includes("batch") &&
				!c.url.includes("/history") &&
				!c.url.includes("/ml/"),
		),
	).toBe(true);
	await f.store.selectSession("batch2");
	expect(f.store.getSnapshot().session).toBe("ordinary");
	expect(f.calls.some((c) => c.url.includes("batch"))).toBe(false);
});
test("Teach Keep, Remove, Unsure and Undo only use calibration writes and synchronize eligible status", async () => {
	const f = setup();
	await f.store.load();
	expect(f.store.getSnapshot().teaching?.status?.trainingFeedbackCount).toBe(0);
	const before = f.calls.length;
	await f.store.skip();
	expect(f.calls.length).toBe(before);
	await f.store.label(1);
	await f.store.showSkipped();
	await f.store.label(0);
	expect(f.store.getSnapshot().teaching?.status?.trainingFeedbackCount).toBe(2);
	expect(f.store.getSnapshot().teaching?.status?.feedbackRevision).toBe(2);
	await f.store.undo(f.history[0]!.labelId);
	expect(f.store.getSnapshot().teaching?.status?.trainingFeedbackCount).toBe(1);
	expect(f.store.getSnapshot().teaching?.status?.feedbackRevision).toBe(3);
	expect(
		f.calls
			.filter((c) => c.init?.method === "POST")
			.every((c) =>
				/\/api\/calibration\/labels(?:\/[^/]+\/undo)?$/.test(c.url),
			),
	).toBe(true);
	expect(f.calls.filter((c) => c.init?.method === "POST")).toHaveLength(3);
});
test("a failed optional status read never loses a confirmed label or claims synchronization", async () => {
	const f = setup();
	await f.store.load();
	f.failStatus();
	await f.store.label(0);
	expect(f.store.getSnapshot().history[0]?.state).toBe("active");
	expect(f.store.getSnapshot().pending).toBeNull();
	expect(f.store.getSnapshot().teaching?.status).toBeNull();
	expect(f.store.getSnapshot().teaching?.warning).not.toContain(
		"private response",
	);
	expect(f.store.getSnapshot().refreshError).toBeNull();
});

test("a delayed status poll cannot overwrite status refreshed after a confirmed answer", async () => {
	const f = setup();
	await f.store.load();
	const read = f.reads.status;
	let resolve!: (value: Awaited<ReturnType<typeof read>>) => void;
	const old = await read();
	f.reads.status = () =>
		new Promise((r) => {
			resolve = r;
		});
	const polling = f.store.refreshTeachingStatus();
	await new Promise((r) => setTimeout(r, 0));
	f.reads.status = read;
	await f.store.label(0);
	resolve(old);
	await polling;
	expect(f.store.getSnapshot().teaching?.status?.feedbackRevision).toBe(1);
	expect(f.store.getSnapshot().teaching?.status?.trainingFeedbackCount).toBe(1);
});

test("overlapping status polls only apply the latest request", async () => {
	const f = setup();
	await f.store.load();
	type Status = Awaited<ReturnType<typeof f.reads.status>>;
	const pending: ((status: Status) => void)[] = [];
	f.reads.status = () => new Promise((resolve) => pending.push(resolve));
	const first = f.store.refreshTeachingStatus();
	const second = f.store.refreshTeachingStatus();
	await new Promise((resolve) => setTimeout(resolve, 0));
	pending[1]!({
		trainingFeedbackCount: 2,
		feedbackRevision: 2,
		synchronizedFeedbackRevision: 2,
		modelVersion: "c1-fixture",
	});
	await second;
	pending[0]!({
		trainingFeedbackCount: 1,
		feedbackRevision: 1,
		synchronizedFeedbackRevision: 0,
		modelVersion: "c1-fixture",
	});
	await first;
	expect(f.store.getSnapshot().teaching?.status?.trainingFeedbackCount).toBe(2);
	expect(f.store.getSnapshot().teaching?.status?.feedbackRevision).toBe(2);
	expect(
		f.store.getSnapshot().teaching?.status?.synchronizedFeedbackRevision,
	).toBe(2);
});
