import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeachView } from "./TeachView";
import { synchronization } from "./status";
import { CalibrationStore } from "../../state/calibration";
import { calibrationFixture } from "../../test-support/calibration-fixture";
import {
	createCalibrationClient,
	calibrationJournal,
} from "../../data/calibration-client";
const callbacks = {
	onAction: () => {},
	onRefresh: () => {},
	onRetry: () => {},
	onUndo: () => {},
	onRetrain: () => {},
	onShowSkipped: () => {},
};
test("ordinary Teach shows preference actions and real eligible counts without research navigation or completion claims", async () => {
	const f = calibrationFixture();
	const store = new CalibrationStore(
		createCalibrationClient(
			f.api,
			f.session,
			calibrationJournal(f.storage, "owner"),
		),
	);
	await store.load();
	const state = {
		...store.getSnapshot(),
		teaching: {
			status: {
				trainingFeedbackCount: 0,
				feedbackRevision: 3,
				synchronizedFeedbackRevision: 2,
				modelVersion: "c1-test",
			},
			warning: null,
		},
	};
	const html = renderToStaticMarkup(<TeachView state={state} {...callbacks} />);
	for (const text of [
		"Teach sort.fm",
		"Still love it",
		"Outgrown",
		"Unsure",
		"Training preferences",
		"waiting for model sync",
		"Spotify stays unchanged",
	])
		expect(html).toContain(text);
	for (const text of [
		"Batch 2",
		"Batch 3",
		"Sampling seed",
		"Retrain",
		"Would remove",
		"progressbar",
		"Held out",
	])
		expect(html).not.toContain(text);
	expect(html.replace(/<[^>]*>/g, "")).not.toMatch(/\d+(?:\.\d+)?%/);
	expect(
		renderToStaticMarkup(
			<TeachView state={{ ...state, session: "batch3" }} {...callbacks} />,
		),
	).not.toContain(state.queue[0]!.track.title);
});
test("synchronization never treats an unknown or stale receipt as synchronized", () => {
	const status = {
		trainingFeedbackCount: 2,
		feedbackRevision: 7,
		synchronizedFeedbackRevision: null,
		modelVersion: null,
	};
	expect(synchronization(null)).toContain("unavailable");
	expect(synchronization(status)).toContain("not confirmed");
	expect(
		synchronization({ ...status, synchronizedFeedbackRevision: 6 }),
	).toContain("waiting");
	expect(synchronization({ ...status, synchronizedFeedbackRevision: 7 })).toBe(
		"Feedback synchronized",
	);
	expect(
		synchronization({ ...status, synchronizedFeedbackRevision: 7 }, 8),
	).toBe("Refreshing saved feedback");
});
