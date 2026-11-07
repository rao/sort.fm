import { expect, test } from "bun:test";
import type { ModelMetrics } from "@sortfm/contracts";
import { coldModelMetrics, liveFixture } from "../test-support/live-fixture";
import { createLiveApi, createLiveClient } from "../data/live-client";
import { ReviewStore } from "./review";
import { demoBootstrap } from "@sortfm/contracts/fixtures";
function setup() {
	const f = liveFixture();
	let writes = 0;
	let userId = "owner";
	let version = "fitted-v2";
	let fail = false;
	let quarantine = false;
	let insightsFail = false;
	let confirmedMetrics: ModelMetrics | null = null;
	let afterFit: (() => void) | undefined;
	let beforeQueue: (() => Promise<void>) | undefined;
	let metrics: ModelMetrics = {
		...demoBootstrap.metrics,
		dataset: "user_feedback" as const,
		modelVersion: "fitted-v2",
		labeledExamples: 30,
		trainedExamples: 10,
		heldOutExamples: 20,
		heldOutPositive: 12,
		heldOutNegative: 8,
	};
	const api = createLiveApi({
		fetch: (async (input, init) => {
			if (String(input).endsWith("/retrain")) {
				writes++;
				if (fail)
					return Response.json(
						{
							code: "OFFLINE",
							message: "Training unavailable",
							retryable: true,
						},
						{ status: 503 },
					);
				confirmedMetrics = structuredClone(metrics);
				afterFit?.();
				return Response.json({
					userId,
					modelVersion: version,
					featureVersion: "sortfm.features.v1",
					feedbackRevision: 30,
					trainedExamples: metrics.trainedExamples,
					metrics,
				});
			}
			if (confirmedMetrics && String(input).includes("/api/queue?"))
				await beforeQueue?.();
			if (insightsFail && String(input).endsWith("/insights")) {
				return Response.json(
					{
						code: "OFFLINE",
						message: "Insights unavailable",
						retryable: false,
					},
					{ status: 503 },
				);
			}
			const response = await f.transport(input, init);
			if (String(input).endsWith("/insights")) {
				const data = await response.json();
				data.metrics = quarantine
					? {
							...data.metrics,
							dataset: "synthetic",
							labeledExamples: 1,
						}
					: (confirmedMetrics ?? data.metrics);
				return Response.json(data);
			}
			return response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	return {
		f,
		store,
		writes: () => writes,
		failInsights: () => {
			insightsFail = true;
		},
		afterFit: (callback: () => void) => {
			afterFit = callback;
		},
		beforeQueue: (callback: () => Promise<void>) => {
			beforeQueue = callback;
		},
		emptyModel: () => {
			metrics = structuredClone(coldModelMetrics);
			version = metrics.modelVersion;
		},
		syntheticModel: () => {
			metrics.dataset = "synthetic";
		},
		quarantine: () => {
			quarantine = true;
		},
		wrongOwner: () => {
			userId = "other";
		},
		wrongVersion: () => {
			version = "wrong";
		},
		fail: () => {
			fail = true;
		},
	};
}
test("retrain serializes duplicate requests and updates only confirmed metrics, preserving exposure predictions", async () => {
	const f = setup();
	await f.store.load();
	const exposure = f.store.getSnapshot().queue[0]!.exposure;
	const pending = f.store.retrain();
	await f.store.decide("KEEP");
	await f.store.retrain();
	await pending;
	expect(f.writes()).toBe(1);
	expect(f.f.commands).toHaveLength(0);
	expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
		"fitted-v2",
	);
	expect(f.store.getSnapshot().bootstrap?.metrics?.labeledExamples).toBe(30);
	expect(f.store.getSnapshot().queue[0]!.exposure).toEqual(exposure);
	expect(f.store.getSnapshot().retrainNotice).toContain("fitted-v2");
});
test("retrain failure keeps last confirmed model and requires model refresh before another fit", async () => {
	const f = setup();
	await f.store.load();
	f.fail();
	await f.store.retrain();
	expect(f.writes()).toBe(1);
	expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
		"untrained-v0",
	);
	expect(f.store.getSnapshot().retrainError).toContain("Training unavailable");
	expect(f.store.getSnapshot().retraining).toBe(false);
	await f.store.retrain();
	expect(f.writes()).toBe(1);
	await f.store.refresh();
	await f.store.retrain();
	expect(f.writes()).toBe(2);
});
test("retraining refuses changed owners and inconsistent result identities", async () => {
	for (const fault of ["session", "response", "version"]) {
		const f = setup();
		await f.store.load();
		if (fault === "session") f.f.session.user!.id = "other";
		if (fault === "response") f.wrongOwner();
		if (fault === "version") f.wrongVersion();
		await f.store.retrain();
		expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
			"untrained-v0",
		);
		expect(f.store.getSnapshot().retrainError).not.toBeNull();
		if (fault === "session") expect(f.writes()).toBe(0);
	}
});
test("pending review recovery blocks retraining", async () => {
	const f = setup();
	await f.store.load();
	f.f.setDecisionError(true);
	await f.store.decide("ARCHIVE");
	const pending = structuredClone(f.f.journal.read());
	await f.store.retrain();
	expect(f.writes()).toBe(0);
	expect(f.f.journal.read()).toEqual(pending);
});

test("a successful model refresh clears a previous retrain recovery alert", async () => {
	const f = setup();
	await f.store.load();
	f.fail();
	await f.store.retrain();
	await f.store.refresh();
	expect(f.store.getSnapshot().retrainError).toBeNull();
});

test("audio-only refresh cannot unlock retraining after an ambiguous failure", async () => {
	const f = setup();
	await f.store.load();
	f.fail();
	await f.store.retrain();
	f.quarantine();
	await f.store.refresh();
	expect(f.store.getSnapshot().insights?.audioFeatures).toBeDefined();
	expect(f.store.getSnapshot().bootstrap?.metrics).toBeNull();
	expect(f.store.getSnapshot().retrainError).not.toBeNull();
	await f.store.retrain();
	expect(f.writes()).toBe(1);
});

test("retrain accepts the exact empty C1 result without inventing a feedback dataset", async () => {
	const f = setup();
	await f.store.load();
	f.emptyModel();
	await f.store.retrain();
	expect(f.store.getSnapshot().retrainError).toBeNull();
	expect(f.store.getSnapshot().bootstrap?.metrics).toEqual(coldModelMetrics);
	expect(f.store.getSnapshot().retrainNotice).toContain(
		"Server confirmed model",
	);
});

test("retrain still rejects nonempty synthetic results without replacing personal metrics", async () => {
	const f = setup();
	await f.store.load();
	const previous = f.store.getSnapshot().bootstrap?.metrics;
	f.syntheticModel();
	await f.store.retrain();
	expect(f.store.getSnapshot().retrainError).not.toBeNull();
	expect(f.store.getSnapshot().bootstrap?.metrics).toEqual(previous);
});

function reorderWithFreshExposures(f: ReturnType<typeof setup>) {
	const next = [...f.f.items].reverse().map((item, position) => ({
		...structuredClone(item),
		prediction: { ...item.prediction, modelVersion: "fitted-v2" },
		exposure: {
			...item.exposure,
			exposureId: crypto.randomUUID(),
			modelVersion: "fitted-v2",
			position,
		},
	}));
	f.f.items.splice(0, f.f.items.length, ...next);
	return next;
}

test("confirmed manual fit replaces queue with fresh server ordering without rewriting served exposures", async () => {
	const f = setup();
	await f.store.load();
	const oldQueue = f.store.getSnapshot().queue;
	const original = structuredClone(oldQueue);
	f.afterFit(() => {
		reorderWithFreshExposures(f);
	});
	await f.store.retrain();
	expect(f.store.getSnapshot().queue).toEqual(f.f.items);
	expect(f.store.getSnapshot().queue[0]!.track.trackId).toBe(
		original[1]!.track.trackId,
	);
	expect(oldQueue).toEqual(original);
	expect(f.f.calls.filter((call) => call.url.includes("/queue?"))).toHaveLength(
		2,
	);
	expect(f.store.getSnapshot().refreshError).toBeNull();
	const fresh = f.store.getSnapshot().queue[0]!;
	await f.store.decide("KEEP");
	expect(f.f.commands[0]!.exposureId).toBe(fresh.exposure.exposureId);
	expect(
		original.some(
			(item) => item.exposure.exposureId === f.f.commands[0]!.exposureId,
		),
	).toBe(false);
	expect(f.writes()).toBe(1);
});

test("manual fit holds all action locks until fresh queue reconciliation completes", async () => {
	const f = setup();
	await f.store.load();
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const observed = new Promise<void>((resolve) => {
		entered = resolve;
	});
	f.beforeQueue(async () => {
		entered();
		await gate;
	});
	const pending = f.store.retrain();
	try {
		await Promise.race([pending, observed]);
		expect(f.store.getSnapshot().retraining).toBe(true);
		await f.store.retrain();
		await f.store.decide("KEEP");
		await f.store.undo(crypto.randomUUID());
		await f.store.refresh();
		expect(f.writes()).toBe(1);
		expect(f.f.commands).toHaveLength(0);
		expect(f.f.calls.some((call) => call.url.endsWith("/undo"))).toBe(false);
	} finally {
		release();
		await pending;
	}
	expect(f.store.getSnapshot().retraining).toBe(false);
});

test("queue failure after confirmed fit retains metrics and recovers by GET without repeating fit", async () => {
	const f = setup();
	await f.store.load();
	const oldQueue = structuredClone(f.store.getSnapshot().queue);
	f.afterFit(() => {
		reorderWithFreshExposures(f);
		f.f.setQueueError(true);
	});
	await f.store.retrain();
	expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
		"fitted-v2",
	);
	expect(f.store.getSnapshot().queue).toEqual(oldQueue);
	expect(f.store.getSnapshot().retrainError).toBeNull();
	expect(f.store.getSnapshot().refreshError).toContain("model was confirmed");
	expect(f.store.getSnapshot().refreshError).toContain("Refresh the queue");
	expect(f.store.getSnapshot().retry).toBeNull();
	expect(f.f.journal.read()).toBeNull();
	await f.store.retrain();
	await f.store.decide("KEEP");
	expect(f.writes()).toBe(1);
	expect(f.f.commands).toHaveLength(0);
	f.f.setQueueError(false);
	await f.store.refresh();
	expect(f.store.getSnapshot().refreshError).toBeNull();
	expect(f.store.getSnapshot().queue).toEqual(f.f.items);
	expect(f.writes()).toBe(1);
});

test("account change during post-fit reconciliation cannot install another owner's queue", async () => {
	const f = setup();
	await f.store.load();
	const oldQueue = structuredClone(f.store.getSnapshot().queue);
	f.afterFit(() => {
		f.f.session.user!.id = "other";
	});
	await f.store.retrain();
	expect(f.writes()).toBe(1);
	expect(f.store.getSnapshot().queue).toEqual(oldQueue);
	expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
		"fitted-v2",
	);
	expect(f.store.getSnapshot().refreshError).toContain("account changed");
	expect(f.store.getSnapshot().retrainError).toBeNull();
	expect(f.f.calls.filter((call) => call.url.includes("/queue?"))).toHaveLength(
		1,
	);
});

test("unavailable optional insights after a fit cannot erase confirmed metrics or discard fresh queue", async () => {
	const f = setup();
	await f.store.load();
	f.afterFit(() => {
		reorderWithFreshExposures(f);
		f.failInsights();
	});
	await f.store.retrain();
	expect(f.store.getSnapshot().bootstrap?.metrics?.modelVersion).toBe(
		"fitted-v2",
	);
	expect(f.store.getSnapshot().queue).toEqual(f.f.items);
	expect(f.store.getSnapshot().warnings.join(" ")).toContain(
		"Insights unavailable",
	);
	expect(f.store.getSnapshot().retrainError).toBeNull();
	expect(f.writes()).toBe(1);
});
