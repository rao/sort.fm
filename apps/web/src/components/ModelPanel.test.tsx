import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoQueue } from "@sortfm/contracts/fixtures";
import type { Prediction } from "@sortfm/contracts";
import { ModelPanel } from "./ModelPanel";

const caveat = "An association, not a cause.";
function render(prediction: Prediction) {
	const html = renderToStaticMarkup(
		<ModelPanel
			prediction={prediction}
			labeled={4}
			total={10}
			metrics={null}
			live
		/>,
	);
	return html
		.slice(
			html.indexOf('<details class="why-song">'),
			html.indexOf('class="text-link model-link"'),
		)
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ");
}
const prediction: Prediction = {
	...demoQueue.items[0]!.prediction,
	modelKind: "logistic",
	removalProbability: 0.6,
	explanations: [
		{
			feature: "saved_age_days",
			value: 2.5,
			contribution: 0.4,
			description: `${caveat} Value uses log(1 + raw observation).`,
		},
		{
			feature: "keep_centroid_distance",
			value: 0.23,
			contribution: -0.12,
			description: caveat,
		},
		{
			feature: "predictive_entropy",
			value: 0.9,
			contribution: null,
			description: "Predictive ambiguity only.",
		},
	],
};

test("explanations preserve model inputs and signed effects while deduplicating shared caveats", () => {
	const text = render(prediction);
	expect(text).toContain("saved age days 2.5 +0.4 → Remove");
	expect(text).toContain("keep centroid distance 0.23 -0.12 → Keep");
	expect(text).toContain("predictive entropy 0.9 Not supplied");
	expect(text.split(caveat)).toHaveLength(2);
	expect(text).toContain("Value uses log(1 + raw observation).");
});

test("heuristic contributions never acquire classifier directions", () => {
	const text = render({
		...prediction,
		modelKind: "heuristic",
		removalProbability: null,
	});
	expect(text).toContain("+0.4");
	expect(text).not.toContain("→ Remove");
	expect(text).not.toContain("→ Keep");
});

test("zero and tiny signed contributions remain distinct from absent contributions", () => {
	const text = render({
		...prediction,
		explanations: [
			{ feature: "zero", value: 0, contribution: 0, description: "" },
			{ feature: "tiny", value: null, contribution: -0.00001, description: "" },
		],
	});
	expect(text).toContain("zero 0 0 · neutral");
	expect(text).toContain("tiny Not supplied -0.00001 → Keep");
});
