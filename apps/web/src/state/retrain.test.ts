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
				return Response.json({
					userId,
					modelVersion: version,
					featureVersion: "sortfm.features.v1",
					feedbackRevision: 30,
					trainedExamples: metrics.trainedExamples,
					metrics,
				});
			}
			const response = await f.transport(input, init);
			if (quarantine && String(input).endsWith("/insights")) {
				const data = await response.json();
				data.metrics = {
					...data.metrics,
					dataset: "synthetic",
					labeledExamples: 1,
				};
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
	await f.store.retrain();
	expect(f.writes()).toBe(0);
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
