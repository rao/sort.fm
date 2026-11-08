import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelLab } from "./ModelLab";
import { ReviewStore } from "../state/review";
import { liveFixture } from "../test-support/live-fixture";

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
