import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalibrationView } from "./Calibration";
import { CalibrationStore } from "../state/calibration";
import {
	calibrationJournal,
	createCalibrationClient,
} from "../data/calibration-client";
import { calibrationExperimentFixture } from "../test-support/calibration-experiment-fixture";
const callbacks = {
	onAction: () => {},
	onRefresh: () => {},
	onRetry: () => {},
	onUndo: () => {},
	onRetrain: () => {},
	onShowSkipped: () => {},
};
async function view(phase: "absent" | "reserved" | "ready") {
	const f = calibrationExperimentFixture();
	f.setPhase(phase);
	const store = new CalibrationStore(
		createCalibrationClient(
			f.api,
			f.session,
			calibrationJournal(f.storage, "owner"),
		),
	);
	await store.selectSession("batch3");
	return {
		f,
		store,
		html: () =>
			renderToStaticMarkup(
				<CalibrationView state={store.getSnapshot()} {...callbacks} />,
			),
	};
}
test.each(["absent", "reserved"] as const)(
	"Batch3 %s renders preparation and progress only without controls or private metadata",
	async (phase) => {
		const v = await view(phase);
		const html = v.html();
		expect(html).toContain(
			phase === "reserved" ? "60 songs reserved" : "Preparation pending",
		);
		expect(html).toContain("Resume Batch 3");
		expect(html).toContain("Check preparation status");
		for (const text of [
			"Private batch song",
			"Would keep",
			"Would remove",
			"Undo label",
			"Retrain from saved feedback",
			"Calibration label history",
			"Sampling seed",
			"test:batch3-frozen",
		])
			expect(html).not.toContain(text);
	},
);
test("ready Batch3 displays accurate cohort counts and hidden predictions with no fit control", async () => {
	const v = await view("ready");
	const html = v.html();
	for (const text of [
		"Batch 3",
		"0 / 60",
		"40",
		"20",
		"permanent",
		"Would keep",
		"Would remove",
		"Predictions are hidden",
		"Private batch song 0",
	])
		expect(html).toContain(text);
	for (const text of [
		"Retrain from saved feedback",
		"test:batch3-frozen",
		"70 labels",
		"98.7",
		"removalProbability",
	])
		expect(html).not.toContain(text);
	await v.store.skip();
	expect(v.html()).toContain("never replaced");
	expect(v.html()).not.toContain("requests a replacement from the same group");
});

test("Batch3 collection may finish with skipped evaluation songs without claiming sixty labels", async () => {
	const v = await view("ready");
	for (let i = 0; i < 40; i++) await v.store.skip();
	for (let i = 0; i < 20; i++) await v.store.label(0);
	const html = v.html();
	expect(html).toContain("Batch 3 collection finished");
	expect(html).toContain("20 of 60 preference labels saved");
	expect(html).toContain("40 skipped without labels");
	expect(html).not.toContain("60 / 60 labels saved");
});
