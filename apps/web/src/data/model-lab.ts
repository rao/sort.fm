import { z } from "zod";
import type { QueueItem, ReviewState } from "../state/review";

const count = z.number().int().nonnegative();
const probability = z.number().min(0).max(1);
const finite = z.number().finite();
export const labModels = ["E1", "E2", "E3", "C1"] as const;
export const labMetricKeys = [
	"roc_auc",
	"average_precision",
	"log_loss",
	"brier",
] as const;
const estimate = z
	.strictObject({ value: finite, low: finite, high: finite })
	.refine((v) => v.low <= v.high);
const model = z.strictObject({
	id: z.enum(labModels),
	metrics: z.strictObject({
		roc_auc: estimate,
		average_precision: estimate,
		log_loss: estimate,
		brier: estimate,
	}),
	bins: z.array(count).length(3),
});
const run = z
	.strictObject({
		id: z.enum(["original52", "current159"]),
		train: count,
		trainKeep: count,
		trainRemove: count,
		test: count,
		testKeep: count,
		testRemove: count,
		models: z.array(model).length(4),
		primaryContrast: estimate,
	})
	.superRefine((v, ctx) => {
		if (
			v.train !== v.trainKeep + v.trainRemove ||
			v.test !== v.testKeep + v.testRemove ||
			new Set(v.models.map((m) => m.id)).size !== 4 ||
			v.models.some((m) => m.bins.reduce((a, b) => a + b, 0) !== v.test)
		)
			ctx.addIssue({
				code: "custom",
				message: "Inconsistent evaluation counts or models",
			});
	});
const explanation = z.strictObject({
	feature: z.string().min(1).max(100),
	before: finite,
	after: finite,
});
// Deliberately an aggregate local presentation format, not a replacement API DTO.
// No track IDs, labels, account IDs, source paths or arbitrary payload fields.
export const LabEvidenceSchema = z
	.strictObject({
		schema: z.literal("sortfm.model-lab.v1"),
		evaluatedAt: z.iso.datetime({ offset: true }),
		resultsSha256: z.string().regex(/^[a-f0-9]{64}$/),
		reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
		diagnosticsSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2),
		runs: z.array(run).length(2),
		feedback: z.strictObject({
			beforeTrain: count,
			afterTrain: count,
			sample: count,
			meanAbsoluteChange: probability,
			cases: z
				.array(
					z.strictObject({
						alias: z.string().regex(/^A\d{2}$/),
						before: probability,
						after: probability,
					}),
				)
				.min(1)
				.max(100),
			explanation: z.strictObject({
				alias: z.string().regex(/^A\d{2}$/),
				interceptBefore: finite,
				interceptAfter: finite,
				terms: z.array(explanation).max(100),
			}),
		}),
	})
	.superRefine((v, ctx) => {
		const before = v.runs.find((r) => r.id === "original52"),
			after = v.runs.find((r) => r.id === "current159");
		if (
			!before ||
			!after ||
			before.train !== v.feedback.beforeTrain ||
			after.train !== v.feedback.afterTrain ||
			before.test !== after.test ||
			before.testKeep !== after.testKeep ||
			before.testRemove !== after.testRemove ||
			v.feedback.sample !== before.test ||
			v.feedback.cases.length !== before.test ||
			new Set(v.feedback.cases.map((c) => c.alias)).size !== before.test ||
			!v.feedback.cases.some((c) => c.alias === v.feedback.explanation.alias)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Feedback comparison must use the same evaluation panel",
			});
		}
		const mean =
			v.feedback.cases.reduce(
				(sum, c) => sum + Math.abs(c.after - c.before),
				0,
			) / v.feedback.cases.length;
		if (Math.abs(mean - v.feedback.meanAbsoluteChange) > 1e-10)
			ctx.addIssue({
				code: "custom",
				message: "Score change summary disagrees with recorded cases",
			});
	});
export type LabEvidence = z.infer<typeof LabEvidenceSchema>;

export function probabilityBins(values: readonly number[]) {
	const bins = [0, 0, 0];
	for (const value of values) {
		if (!Number.isFinite(value) || value < 0 || value > 1) continue;
		const index = value < 1 / 3 ? 0 : value < 2 / 3 ? 1 : 2;
		bins[index] = bins[index]! + 1;
	}
	return bins;
}

export function liveDistribution(state: ReviewState) {
	const version = state.bootstrap?.metrics?.modelVersion;
	const unique = new Map<string, QueueItem>();
	for (const item of state.queue)
		if (!unique.has(item.track.trackId)) unique.set(item.track.trackId, item);
	const items = [...unique.values()].filter(
		(item) =>
			item.track.source === "spotify" &&
			item.prediction.modelVersion === version &&
			item.prediction.removalProbability !== null &&
			!["untrained", "heuristic"].includes(item.prediction.modelKind),
	);
	return {
		version,
		items,
		bins: probabilityBins(
			items.map((item) => item.prediction.removalProbability!),
		),
		excluded: unique.size - items.length,
	};
}

// Structural adapter for the integration branch's optional C2 telemetry. The
// shared contract remains integration-owned; no inference from C1 probabilities.
const policyView = z.object({
	selectionMethod: z.enum(["c1", "epsilon_greedy", "linucb", "random"]),
	strategy: z.enum(["explore", "exploit"]),
	policyStateVersion: z.string(),
	rewardVersion: z.string(),
	predictedReward: finite,
	selectionScore: finite,
	explorationBonus: finite.nonnegative(),
	trainedRewards: count,
	reasons: z.array(z.string()),
});
export function readPolicy(item: QueueItem | null | undefined) {
	if (
		!item ||
		item.track.source !== "spotify" ||
		!("policyTelemetry" in item.exposure)
	)
		return null;
	const parsed = policyView.safeParse(item.exposure.policyTelemetry);
	return parsed.success ? parsed.data : null;
}
export function policyOutcomes(state: ReviewState) {
	return state.history.flatMap((entry) => {
		const policy = readPolicy(entry.item);
		return policy &&
			entry.result.mode === "spotify" &&
			entry.item?.exposure.exposureId === entry.result.exposureId &&
			["COMPLETE", "UNDONE"].includes(entry.result.status)
			? [{ ...entry, policy }]
			: [];
	});
}
