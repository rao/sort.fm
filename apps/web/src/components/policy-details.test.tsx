import { expect, test } from "bun:test";
import { PolicyTelemetrySchema, type PolicyTelemetry } from "@sortfm/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Insights } from "./Insights";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "../state/review";
import { createLiveApi, createLiveClient } from "../data/live-client";

const telemetry = PolicyTelemetrySchema.parse({
	selectionMethod: "linucb",
	strategy: "explore",
	policyStateVersion: "policy-state-17",
	contextVersion: "context-v2",
	rewardVersion: "reward-v1",
	modelFeedbackRevision: 12,
	predictedReward: -0.375,
	selectionScore: 2.75,
	uncertainty: 3.5,
	explorationBonus: 3.125,
	informationGain: 1.25,
	candidateCount: 200,
	availableCount: 150,
	eligibleCount: 80,
	trainedRewards: 0,
	reasons: ["Exploring a less familiar part of your library."],
	reservation: {
		reservedAt: "2026-11-07T12:00:00.000Z",
		expiresAt: "2026-11-07T12:05:00.000Z",
		evaluatedAt: "2026-11-07T12:01:00.000Z",
		status: "active",
		closedAt: null,
		closureReason: null,
	},
});

async function setup(policy: PolicyTelemetry | undefined = telemetry) {
	const f = liveFixture();
	f.items[0]!.exposure = {
		...f.items[0]!.exposure,
		selectionMethod: "linucb",
		policyVersion: "linucb-policy-v4",
		...(policy ? { policyTelemetry: policy } : {}),
	};
	const store = new ReviewStore(f.client);
	await store.load();
	return { f, store, state: structuredClone(store.getSnapshot()) };
}

test("inspector renders unbounded policy values separately from classifier uncertainty", async () => {
	const { state } = await setup();
	state.queue[0]!.prediction.uncertainty = 0.25;
	state.queue[0]!.prediction.uncertaintyMethod = "entropy";
	const html = renderToStaticMarkup(<Insights state={state} />);
	for (const value of [
		"Why this song was selected",
		"Predicted review reward",
		"-0.375",
		"Selection score",
		"2.750",
		"Exploration bonus",
		"3.125",
		"Policy uncertainty radius",
		"3.500",
		"Uncalibrated",
		"policy-state-17",
		"linucb-policy-v4",
		"context-v2",
		"reward-v1",
		telemetry.reasons[0]!,
	]) {
		expect(html).toContain(value);
	}
	expect(html).toContain("0.25 (entropy)");
	expect(html).not.toContain("350%");
	expect(html).not.toContain("275%");
});

test("zero policy quantities are rendered as supplied rather than unavailable", async () => {
	const zero = PolicyTelemetrySchema.parse({
		...telemetry,
		predictedReward: 0,
		selectionScore: 0,
		uncertainty: 0,
		explorationBonus: 0,
		informationGain: 0,
		modelFeedbackRevision: 0,
		candidateCount: 0,
		availableCount: 0,
		eligibleCount: 0,
		trainedRewards: 0,
		reasons: [],
	});
	const { state } = await setup(zero);
	const html = renderToStaticMarkup(<Insights state={state} />);
	expect(html.match(/0\.000/g)?.length).toBeGreaterThanOrEqual(5);
	expect(html).toContain("No selection reasons supplied.");
	expect(html).not.toContain("Policy telemetry was not supplied");
});

test("legacy exposure shows real selection identity without fabricated C2 telemetry", async () => {
	const { state } = await setup();
	delete state.queue[0]!.exposure.policyTelemetry;
	state.queue[0]!.exposure.selectionMethod = "logistic_rank";
	state.queue[0]!.exposure.policyVersion = "c1-ranked-v1";
	const html = renderToStaticMarkup(<Insights state={state} />);
	expect(html).toContain("c1-ranked-v1");
	expect(html).toContain("logistic_rank");
	expect(html).toContain(
		"Policy telemetry was not supplied for this exposure.",
	);
	expect(html).not.toContain("Predicted review reward");
});

test.each(["c1", "epsilon_greedy", "linucb", "random"] as const)(
	"renders reported %s selector without activating or substituting a policy",
	async (selectionMethod) => {
		const { state } = await setup({ ...telemetry, selectionMethod });
		const html = renderToStaticMarkup(<Insights state={state} />);
		expect(html).toContain(`>${selectionMethod}<`);
		expect(html).not.toContain("Switch policy");
	},
);

test.each([
	["active", null, null, "2026-11-07T12:01:00.000Z", "Active"],
	[
		"released",
		"2026-11-07T12:02:00.000Z",
		"explicit_release",
		"2026-11-07T12:03:00.000Z",
		"Explicit release",
	],
	[
		"released",
		"2026-11-07T12:02:00.000Z",
		"undo",
		"2026-11-07T12:03:00.000Z",
		"Undo",
	],
	[
		"expired",
		"2026-11-07T12:05:00.000Z",
		"expiry",
		"2026-11-07T12:06:00.000Z",
		"Expiry",
	],
] as const)(
	"reservation %s is a reported snapshot, never inferred from the current clock",
	async (status, closedAt, closureReason, evaluatedAt, label) => {
		const policy = PolicyTelemetrySchema.parse({
			...telemetry,
			reservation: {
				...telemetry.reservation,
				status,
				closedAt,
				closureReason,
				evaluatedAt,
			},
		});
		const { state } = await setup(policy);
		const html = renderToStaticMarkup(<Insights state={state} />);
		expect(html).toContain(label);
		expect(html).toContain(`dateTime="${evaluatedAt}"`);
		expect(html).toContain("Reported at");
		expect(html).toContain("not proof of listening");
		if (status === "active") {
			expect(html).toContain("Not closed in this snapshot");
			expect(html).not.toContain("Expired");
		}
	},
);

test("policy telemetry remains visible independently of unavailable model evaluation", async () => {
	const { state } = await setup();
	state.bootstrap!.metrics = null;
	const html = renderToStaticMarkup(<Insights state={state} />);
	expect(html).toContain("Your model is not available yet");
	expect(html).toContain("policy-state-17");
	expect(html).toContain("Predicted review reward");
});

test("empty queue never shows a previous exposure or invented scores", async () => {
	const { state } = await setup();
	state.queue = [];
	const html = renderToStaticMarkup(<Insights state={state} />);
	expect(html).toContain("No queued song to inspect.");
	expect(html).not.toContain("policy-state-17");
	expect(html).not.toContain("Predicted review reward");
});

test("shared HTTP decoding and store refresh preserve exposure telemetry, then remove it for a legacy replacement", async () => {
	const { f, store } = await setup();
	const selected = structuredClone(store.getSnapshot().queue[0]!.exposure);
	expect(selected.policyTelemetry).toEqual(telemetry);
	await store.refresh();
	expect(store.getSnapshot().queue[0]!.exposure).toEqual(selected);
	delete f.items[0]!.exposure.policyTelemetry;
	f.items[0]!.exposure.policyVersion = "c1-fallback-v5";
	await store.refresh();
	const html = renderToStaticMarkup(<Insights state={store.getSnapshot()} />);
	expect(html).toContain("c1-fallback-v5");
	expect(html).not.toContain("policy-state-17");
	expect(html).toContain("Policy telemetry was not supplied");
	expect(selected.policyTelemetry).toEqual(telemetry);
});

test("retraining updates model metrics without rewriting saved policy or prediction identity", async () => {
	const { f, state } = await setup();
	let trained = false;
	const metrics = {
		...state.bootstrap!.metrics!,
		modelVersion: "newly-fitted-v9",
	};
	const api = createLiveApi({
		fetch: (async (input, init) => {
			if (String(input).endsWith("/retrain")) {
				trained = true;
				return Response.json({
					userId: f.session.user!.id,
					modelVersion: metrics.modelVersion,
					featureVersion: state.queue[0]!.exposure.featureVersion,
					feedbackRevision: 13,
					trainedExamples: metrics.trainedExamples,
					metrics,
				});
			}
			const response = await f.transport(input, init);
			if (trained && String(input).endsWith("/insights"))
				return Response.json({ ...(await response.json()), metrics });
			return response;
		}) as typeof fetch,
	});
	const store = new ReviewStore(createLiveClient(api, f.session, f.journal));
	await store.load();
	const before = structuredClone(store.getSnapshot().queue[0]!);
	await store.retrain();
	const after = store.getSnapshot();
	expect(after.retrainError).toBeNull();
	expect(after.bootstrap!.metrics!.modelVersion).toBe("newly-fitted-v9");
	expect(after.queue[0]!.prediction).toEqual(before.prediction);
	expect(after.queue[0]!.exposure).toEqual(before.exposure);
	const html = renderToStaticMarkup(<Insights state={after} />);
	expect(html).toContain("policy-state-17");
	expect(html).toContain("linucb-policy-v4");
	expect(html).toContain(before.exposure.modelVersion);
});
