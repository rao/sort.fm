import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Batch3Evaluation } from "./Batch3Evaluation";

test("Batch 3 presents the authorized frozen aggregates and paired uncertainty", () => {
	const html = renderToStaticMarkup(<Batch3Evaluation />);
	expect(html).toContain("LATEST · FROZEN PROSPECTIVE");
	for (const count of [159, 40, 26, 14]) {
		expect(html).toContain(`<dd>${count}</dd>`);
	}
	for (const value of [
		"0.739",
		"0.694",
		"0.645",
		"0.230",
		"0.780",
		"0.707",
		"0.605",
		"0.211",
	]) {
		expect(html).toContain(`<strong>${value}</strong>`);
	}
	expect(html).toContain("C1 − E2 log-loss difference");
	expect(html).toContain("−0.0398");
	expect(html).toContain("[−0.0927, +0.0178]");
	expect(html).toContain("superiority is not established");
});

test("Batch 3 preserves provenance and keeps consumed outcomes separate from learning", () => {
	const html = renderToStaticMarkup(<Batch3Evaluation />);
	expect(html).toContain("all four paired 95% intervals include zero");
	expect(html).toContain("different song panels");
	expect(html).toContain("not evidence of model learning");
	expect(html).toContain("permanently excluded from training");
	expect(html).toContain("consumed");
	expect(html).toContain(
		"d63dd93c1f0dbf3e4c7886d28c6bf4c4aae4a064cdcbd64d934226cc4e0dc3d0",
	);
	expect(html).not.toContain("/Users/");
	expect(html).not.toContain("spotify:track:");
});
