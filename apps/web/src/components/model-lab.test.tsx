import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelLab } from "./ModelLab";
import { ReviewStore } from "../state/review";
import { liveFixture } from "../test-support/live-fixture";
import { createDemoClient } from "../data/demo-client";

test("Experiments presents Batch 3 before separate historical Batch 2 without a local export", async () => {
	const store = new ReviewStore(createDemoClient({ latency: 0 }));
	await store.load();
	const html = renderToStaticMarkup(<ModelLab state={store.getSnapshot()} />);
	expect(html).toContain("Batch 3 / The latest evaluation");
	expect(html).toContain("Batch 2 / Historical comparison");
	expect(html.indexOf("Batch 3 / The latest evaluation")).toBeLessThan(
		html.indexOf("Batch 2 / Historical comparison"),
	);
	expect(html).toContain("completed Batch 2 research export");
	expect(html).toContain("permanently excluded from training");
});

test("Live Model Lab renders supplied counts and distinguishes missing metrics from zero", async () => {
	const fixture = liveFixture(),
		store = new ReviewStore(fixture.client);
	await store.load();
	const state = structuredClone(store.getSnapshot());
	state.bootstrap!.metrics = {
		...state.bootstrap!.metrics!,
		labeledExamples: 61,
		trainedExamples: 41,
		heldOutExamples: 20,
		heldOutPositive: 12,
		heldOutNegative: 8,
	};
	const html = renderToStaticMarkup(<ModelLab state={state} />);
	expect(html).not.toContain("Batch 3 / The latest evaluation");
	expect(html).toContain("<dd>61</dd>");
	expect(html).toContain("<dd>41</dd>");
	expect(html).toContain("<dd>20</dd>");
	expect(html).toContain("Training class mix is not supplied");
	expect(html).toContain("No current-version trained probabilities");
	state.bootstrap!.metrics = null;
	const missing = renderToStaticMarkup(<ModelLab state={state} />);
	expect(missing.match(/<dd>—<\/dd>/g)).toHaveLength(3);
	expect(missing).not.toContain("<dd>0</dd>");
});
