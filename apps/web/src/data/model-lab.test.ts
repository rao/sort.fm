import { describe, expect, test } from "bun:test";
import { demoBootstrap, demoQueue } from "@sortfm/contracts/fixtures";
import { ReviewStore, type QueueItem, type ReviewState } from "../state/review";
import { createDemoClient } from "./demo-client";
import { liveFixture } from "../test-support/live-fixture";
import {
	LabEvidenceSchema,
	labModels,
	labMetricKeys,
	liveDistribution,
	policyOutcomes,
	probabilityBins,
	readPolicy,
} from "./model-lab";

function state(): ReviewState {
	return {
		...new ReviewStore(createDemoClient()).getSnapshot(),
		bootstrap: structuredClone(demoBootstrap),
	};
}
function item(
	id: string,
	version = "current",
	probability: number | null = 0.5,
): QueueItem {
	const value = structuredClone(demoQueue.items[0]!);
	value.track.source = "spotify";
	value.track.trackId = id;
	value.prediction = {
		...value.prediction,
		modelKind: "logistic",
		modelVersion: version,
		removalProbability: probability,
	};
	return value;
}
const telemetry = {
	selectionMethod: "linucb",
	strategy: "explore",
	policyStateVersion: "test",
	rewardVersion: "test",
	predictedReward: 0.2,
	selectionScore: 0.7,
	explorationBonus: 0.5,
	trainedRewards: 3,
	reasons: ["Synthetic test only"],
};
function policyItem() {
	const value = item("test");
	Object.assign(value.exposure, { policyTelemetry: telemetry });
	return value;
}

describe("Model Lab live evidence", () => {
	test("bin boundaries include 1; invalid probabilities are never counted", () => {
		expect(probabilityBins([0, 1 / 3, 2 / 3, 1, NaN, -1, 1.1])).toEqual([
			1, 1, 2,
		]);
	});
	test("histogram excludes old models, heuristic scores, absent scores and synthetic tracks; deduplicates songs", () => {
		const s = state();
		s.bootstrap!.metrics = {
			...demoBootstrap.metrics,
			modelVersion: "current",
		};
		const heuristic = item("heuristic");
		heuristic.prediction.modelKind = "heuristic";
		s.queue = [
			item("one"),
			item("one"),
			item("two", "old"),
			item("three", "current", null),
			heuristic,
			demoQueue.items[0]!,
		];
		const result = liveDistribution(s);
		expect(result.items.map((i) => i.track.trackId)).toEqual(["one"]);
		expect(result.bins).toEqual([0, 1, 0]);
		expect(result.excluded).toBe(4);
	});
	test("missing current model does not silently borrow a served model version", () => {
		const s = state();
		s.bootstrap!.metrics = null;
		s.queue = [item("one")];
		expect(liveDistribution(s).items).toHaveLength(0);
	});
	test("policy needs actual telemetry, never inferred from probability or exploration coefficient", () => {
		expect(readPolicy(item("one"))).toBeNull();
		expect(readPolicy(demoQueue.items[0])).toBeNull();
		expect(readPolicy(policyItem())?.strategy).toBe("explore");
		const invalid = policyItem();
		Object.assign(invalid.exposure, {
			policyTelemetry: { ...telemetry, strategy: "unknown" },
		});
		expect(readPolicy(invalid)).toBeNull();
	});
	test("outcomes require exact exposure linkage and completed/undone live records", async () => {
		const store = new ReviewStore(createDemoClient());
		await store.load();
		await store.decide("KEEP");
		const original = store.getSnapshot().history[0]!;
		const entry = {
			item: policyItem(),
			result: { ...original.result, mode: "spotify" as const },
		};
		entry.item.exposure.exposureId = entry.result.exposureId;
		const s = state();
		s.history = [entry];
		expect(policyOutcomes(s)).toHaveLength(1);
		s.history = [
			{
				...entry,
				result: {
					...entry.result,
					status: "UNDONE",
					labelState: "revoked",
					label: null,
				},
			},
		];
		expect(policyOutcomes(s)[0]?.result.labelState).toBe("revoked");
		s.history = [
			{ ...entry, result: { ...entry.result, exposureId: "different" } },
		];
		expect(policyOutcomes(s)).toHaveLength(0);
		s.history = [{ ...entry, result: { ...entry.result, status: "PENDING" } }];
		expect(policyOutcomes(s)).toHaveLength(0);
		s.history = [{ ...entry, item: null }];
		expect(policyOutcomes(s)).toHaveLength(0);
	});
	test("Undo refresh retains the original policy exposure when the same song is requeued", async () => {
		const fixture = liveFixture();
		const store = new ReviewStore(fixture.client);
		await store.load();
		const original = store.getSnapshot().queue[0]!;
		Object.assign(original.exposure, { policyTelemetry: telemetry });
		await store.decide("KEEP");
		const decision = store.getSnapshot().history[0]!.result;
		await store.undo(decision.decisionId);
		const refreshed = store.getSnapshot();
		expect(
			refreshed.queue.find((i) => i.track.trackId === original.track.trackId)
				?.exposure.exposureId,
		).not.toBe(original.exposure.exposureId);
		expect(refreshed.history[0]?.item?.exposure.exposureId).toBe(
			original.exposure.exposureId,
		);
		expect(policyOutcomes(refreshed)[0]?.result.labelState).toBe("revoked");
	});
});

// Artificial schema fixtures only. No private measured values are committed.
function evidence() {
	return {
		schema: "sortfm.model-lab.v1",
		evaluatedAt: "2026-01-01T00:00:00Z",
		resultsSha256: "a".repeat(64),
		reportSha256: "b".repeat(64),
		diagnosticsSha256: ["c".repeat(64), "d".repeat(64)],
		runs: ["original52", "current159"].map((id, i) => ({
			id,
			train: i + 2,
			trainKeep: 1,
			trainRemove: i + 1,
			test: 2,
			testKeep: 1,
			testRemove: 1,
			primaryContrast: { value: 0, low: -1, high: 1 },
			models: labModels.map((id) => ({
				id,
				bins: [1, 0, 1],
				metrics: Object.fromEntries(
					labMetricKeys.map((k) => [k, { value: 0.5, low: 0, high: 1 }]),
				),
			})),
		})),
		feedback: {
			beforeTrain: 2,
			afterTrain: 3,
			sample: 2,
			meanAbsoluteChange: 0.1,
			cases: [
				{ alias: "A01", before: 0.4, after: 0.5 },
				{ alias: "A02", before: 0.4, after: 0.5 },
			],
			explanation: {
				alias: "A01",
				interceptBefore: 0,
				interceptAfter: 0,
				terms: [],
			},
		},
	};
}
describe("Local research import boundary", () => {
	test("accepts aggregate evidence without account or track data", () =>
		expect(LabEvidenceSchema.safeParse(evidence()).success).toBe(true));
	test("rejects inconsistent panel, class counts, histogram and duplicated models", () => {
		for (const change of [
			(v: ReturnType<typeof evidence>) => {
				v.runs[1]!.test = 3;
			},
			(v: ReturnType<typeof evidence>) => {
				v.runs[0]!.trainKeep = 100;
			},
			(v: ReturnType<typeof evidence>) => {
				v.runs[0]!.models[0]!.bins = [0, 0, 0];
			},
			(v: ReturnType<typeof evidence>) => {
				v.runs[0]!.models[0]!.id = "C1";
			},
			(v: ReturnType<typeof evidence>) => {
				v.feedback.cases[1]!.alias = "A01";
			},
		]) {
			const v = evidence();
			change(v);
			expect(LabEvidenceSchema.safeParse(v).success).toBe(false);
		}
	});
	test("rejects extra private fields and nonfinite metrics", () => {
		expect(
			LabEvidenceSchema.safeParse({ ...evidence(), accountId: "private" })
				.success,
		).toBe(false);
		const v = evidence();
		Object.assign(v.feedback.cases[0]!, { trackId: "private" });
		expect(LabEvidenceSchema.safeParse(v).success).toBe(false);
		const n = evidence();
		n.runs[0]!.primaryContrast.value = Infinity;
		expect(LabEvidenceSchema.safeParse(n).success).toBe(false);
	});
});
