import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createIdempotencyKey } from "@sortfm/contracts/client";
import { History } from "./History";
import { ReviewStore } from "../state/review";
import { liveFixture } from "../test-support/live-fixture";
import type { CorrectionState } from "../state/corrections";

async function setup() {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	await store.decide("SKIP");
	await store.decide("SKIP");
	const state = store.getSnapshot();
	const latest = state.history[0]!;
	state.history.push({
		...latest,
		result: {
			...latest.result,
			decisionId: crypto.randomUUID(),
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		},
	});
	return {
		state,
		onUndo: () => {},
		corrections: {
			state: {
				ready: true,
				busy: false,
				refreshing: false,
				pending: null,
				labels: [],
				historyHasMore: false,
				error: null,
				notice: "",
			} as CorrectionState,
			onCorrect: () => {},
			onUndo: () => {},
			onRetry: () => {},
			onRefresh: () => {},
		},
	};
}

test("history offers one explicit Remove-only confirmation per latest skipped track", async () => {
	const props = await setup();
	const html = renderToStaticMarkup(<History {...props} />);
	expect(html.match(/Label Remove only/g)).toHaveLength(2);
	expect(html).toContain(
		"Save a Remove preference only. Spotify will not change. Original Skip stays in history; this is not a C2 reward.",
	);
	expect(html.match(/Confirm Remove preference/g)).toHaveLength(2);
	expect(html.match(/decision-tag skip">Skipped</g)).toHaveLength(3);
	expect(html).not.toContain("Correct all");
});

test("a later non-Skip decision prevents an older Skip correction control", async () => {
	const props = await setup();
	props.state.history[0]!.result = {
		...props.state.history[0]!.result,
		action: "KEEP",
		label: 0,
		labelState: "active",
	};
	const html = renderToStaticMarkup(<History {...props} />);
	expect(html.match(/Label Remove only/g)).toHaveLength(1);
});

test("demo history never offers real preference corrections", async () => {
	const props = await setup();
	for (const entry of props.state.history) entry.result.mode = "demo";
	const html = renderToStaticMarkup(<History {...props} />);
	expect(html).not.toContain("Label Remove only");
});

test("an in-flight preference save does not advertise ambiguous recovery", async () => {
	const props = await setup();
	const decision = props.state.history[0]!.result;
	props.corrections.state.busy = true;
	props.corrections.state.pending = {
		kind: "correct",
		trackId: decision.trackId,
		request: {
			decisionId: decision.decisionId,
			idempotencyKey: createIdempotencyKey(),
			label: 1,
		},
	};
	const html = renderToStaticMarkup(<History {...props} />);
	expect(html).toContain("Saving preference change…");
	expect(html).not.toContain("needs recovery");
	expect(html).not.toContain("Retry saved preference request");
});

test("preference status and Undo remain separate from original Skip status", async () => {
	const props = await setup();
	const decision = props.state.history[0]!.result;
	props.corrections.state.labels = [
		{
			mode: "calibration",
			labelId: crypto.randomUUID(),
			trackId: decision.trackId,
			exposureId: crypto.randomUUID(),
			idempotencyKey: createIdempotencyKey(),
			submittedLabel: 1,
			label: 1,
			state: "active",
			canUndo: true,
			feedbackRevision: 1,
			createdAt: decision.createdAt,
			updatedAt: decision.updatedAt,
		},
	];
	const html = renderToStaticMarkup(<History {...props} />);
	expect(html).toContain("Remove active");
	expect(html.match(/Undo preference label/g)).toHaveLength(1);
	expect(html.match(/Label Remove only/g)).toHaveLength(1);
	expect(html.match(/decision-tag skip">Skipped</g)).toHaveLength(3);
});

test.each(["SKIP", "KEEP"] as const)(
	"Activity describes %s Undo without claiming Spotify restoration",
	async (action) => {
		const props = await setup();
		props.state.history = [
			{
				...props.state.history[0]!,
				result: {
					...props.state.history[0]!.result,
					status: "UNDONE",
					action,
					canUndo: false,
					label: null,
					labelState: "revoked",
				},
			},
		];
		const html = renderToStaticMarkup(<History {...props} />);
		expect(html).toContain(action === "SKIP" ? "Skip undone" : "Keep undone");
		expect(html).not.toContain(">Restored<");
	},
);
