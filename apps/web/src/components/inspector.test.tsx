import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaybackControls } from "./PlaybackControls";
import { Insights } from "./Insights";
import { PredictionDisplay } from "./ModelPanel";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "../state/review";

test("inspector displays every supplied metric, missingness and exposure identity without invented training mix", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	const state = structuredClone(store.getSnapshot());
	state.bootstrap!.metrics = {
		...state.bootstrap!.metrics!,
		status: "available",
		dataset: "user_feedback",
		modelVersion: "fitted-v3",
		evaluationMethod: "fixed_holdout",
		labeledExamples: 60,
		trainedExamples: 40,
		heldOutExamples: 20,
		heldOutPositive: 12,
		heldOutNegative: 8,
		baseRate: 0.6,
		balancedAccuracy: 0.7,
		rocAuc: 0.75,
		prAuc: 0.8,
		logLoss: 0.4,
		brierScore: 0.2,
		precisionAtK: null,
		evaluatedAt: "2026-11-07T16:00:00.000Z",
	};
	state.insights!.audioFeatures.missingness = { energy: 0, tempo_bpm: 0.25 };
	state.insights!.audioFeatures.failed = 2;
	const html = renderToStaticMarkup(
		<Insights state={state} onRetrain={() => {}} onRefresh={() => {}} />,
	);
	for (const text of [
		"PR-AUC",
		"Log loss",
		"Removal base rate",
		"Precision at k",
		"Not supplied",
		"2026-11-07T16:00:00.000Z",
		"energy",
		"100% present",
		"tempo_bpm",
		"75% present",
		"fitted-v3",
		"untrained-v0",
		"Training class mix",
		"Not supplied by the API",
		"Retrain model",
	])
		expect(html).toContain(text);
});
test("heuristic score is explicit and never rendered as removal probability", () => {
	const prediction = {
		...liveFixture().items[0]!.prediction,
		modelKind: "heuristic" as const,
		heuristicScore: 0.7,
		modelVersion: "baseline-v1",
	};
	const html = renderToStaticMarkup(
		<PredictionDisplay prediction={prediction} />,
	);
	expect(html).toContain("Heuristic rank score");
	expect(html).toContain("0.700");
	expect(html).toContain("baseline-v1");
	expect(html).not.toContain("70%");
});
test("missing metrics still offers recovery and does not claim insufficient training data", async () => {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	const state = structuredClone(store.getSnapshot());
	state.bootstrap!.metrics = null;
	const html = renderToStaticMarkup(
		<Insights state={state} onRetrain={() => {}} onRefresh={() => {}} />,
	);
	expect(html).toContain("Refresh model data");
	expect(html).not.toContain("Not enough data. Yet.");
});

test("history disables Undo with an explanation while model training is in flight", async () => {
	const { History } = await import("./History");
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	await store.decide("KEEP");
	const state = { ...store.getSnapshot(), retraining: true };
	const html = renderToStaticMarkup(
		<History state={state} onUndo={() => {}} />,
	);
	expect(html).toMatch(/class="button ghost small" disabled=""/);
	expect(html).toContain("Training is in progress");
});

test("unplayable tracks retain Spotify fallback without enabling playback requests", () => {
	const { client } = liveFixture();
	client.live!.session.capabilities.playback = true;
	const html = renderToStaticMarkup(
		<PlaybackControls
			gateway={client.live!}
			trackUri={`spotify:track:${"0".repeat(22)}`}
			playable={false}
		/>,
	);
	expect(html).toContain("Spotify marks this track unavailable");
	expect(html).not.toContain("Play selected song");
});
