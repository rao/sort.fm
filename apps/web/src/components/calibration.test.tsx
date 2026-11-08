import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CalibrationView, CalibrationWorkspace } from "./Calibration";
import { CalibrationStore } from "../state/calibration";
import {
	calibrationJournal,
	createCalibrationClient,
} from "../data/calibration-client";
import { calibrationFixture } from "../test-support/calibration-fixture";
const callbacks = {
	onAction: () => {},
	onRefresh: () => {},
	onRetry: () => {},
	onUndo: () => {},
	onRetrain: () => {},
	onShowSkipped: () => {},
};
test("calibration displays real track metadata but never song predictions or destructive controls", async () => {
	const f = calibrationFixture();
	const store = new CalibrationStore(
		createCalibrationClient(
			f.api,
			f.session,
			calibrationJournal(f.storage, "owner"),
		),
	);
	await store.load();
	const state = structuredClone(store.getSnapshot());
	state.queue[0]!.prediction.removalProbability = 0.987;
	state.queue[0]!.prediction.uncertainty = 0.123;
	const html = renderToStaticMarkup(
		<CalibrationView state={state} {...callbacks} />,
	);
	for (const value of [
		"Would keep",
		"Would remove",
		"Skip",
		"Predictions are hidden",
		state.queue[0]!.track.title,
		"Calibration label history",
	])
		expect(html).toContain(value);
	for (const value of [
		"98.7",
		"0.987",
		"0.123",
		"Removal estimate",
		"Unlike song",
		"Archive song",
	])
		expect(html).not.toContain(value);
});
test("calibration cannot silently turn into demo cleanup", () => {
	const html = renderToStaticMarkup(<CalibrationWorkspace store={null} />);
	expect(html).toContain("Teach sort.fm with your connected library");
	expect(html).not.toContain("Would remove");
});
