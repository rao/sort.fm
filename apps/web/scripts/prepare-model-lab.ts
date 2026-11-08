import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import {
	LabEvidenceSchema,
	labModels,
	labMetricKeys,
	probabilityBins,
} from "../src/data/model-lab";

// Takes the completed research evaluation-v1 directory, never fits a model or
// reads a new evaluation panel. Output is ignored and excluded from builds.
const directory = process.argv[2];
if (!directory)
	throw new Error(
		"Usage: bun apps/web/scripts/prepare-model-lab.ts /absolute/evaluation-v1",
	);
const source = resolve(directory);
const read = async (name: string) =>
	JSON.parse(await readFile(join(source, name), "utf8"));
const hash = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const delivery = await read("delivery-manifest.json");
const resultsBytes = await readFile(
	join(source, "first-evaluation/results.json"),
);
const reportBytes = await readFile(
	join(source, "sort-fm-frozen-evaluation.md"),
);
if (
	delivery.status !== "complete" ||
	delivery.files["first-evaluation/results.json"] !== hash(resultsBytes) ||
	delivery.files["sort-fm-frozen-evaluation.md"] !== hash(reportBytes)
)
	throw new Error("Completed research delivery hashes do not match");
const results = JSON.parse(resultsBytes.toString());
const diagnosticsManifest = await read(
	"feature-diagnostics/diagnostics-manifest.json",
);
const diagnosticsBytes = await Promise.all(
	[52, 159].map((n) =>
		readFile(join(source, `feature-diagnostics/cohort-${n}-diagnostics.json`)),
	),
);
const diagnostics = diagnosticsBytes.map((bytes, i) => {
	if (
		hash(bytes) !==
		diagnosticsManifest.outputs[`cohort-${[52, 159][i]}-diagnostics.json`]
	)
		throw new Error("Feature diagnostics hash mismatch");
	return JSON.parse(bytes.toString());
});
for (const d of diagnostics)
	if (!d.models.C1.exact_decomposition_check.passed)
		throw new Error("Unverified explanation decomposition");
if (diagnostics[0].candidate_sha256 !== diagnostics[1].candidate_sha256)
	throw new Error("Different frozen evaluation features");
const runs = ["original52", "current159"].map((id, i) => {
	const run = results.comparisons[id],
		d = diagnostics[i];
	if (run.training_n !== d.training_n)
		throw new Error("Training counts disagree");
	for (const model of labModels) {
		const bins = probabilityBins(
			d.models[model].rows.map(
				(row: { uncalibrated_removal_score: number }) =>
					row.uncalibrated_removal_score,
			),
		);
		if (
			JSON.stringify(bins) !==
			JSON.stringify(
				run.models[model].calibration_bins.map(
					(b: { count: number }) => b.count,
				),
			)
		)
			throw new Error("Diagnostics disagree with measured distribution");
	}
	return {
		id,
		train: run.training_n,
		trainKeep: d.models.C1.training_class_counts.keep,
		trainRemove: d.models.C1.training_class_counts.remove,
		test: run.counts.total,
		testKeep: run.counts.keep,
		testRemove: run.counts.remove,
		primaryContrast: {
			value: run.primary_contrast.delta,
			low: run.primary_contrast.low,
			high: run.primary_contrast.high,
		},
		models: labModels.map((id) => ({
			id,
			metrics: Object.fromEntries(
				labMetricKeys.map((key) => [
					key,
					{
						value: run.models[id].metrics[key],
						low: run.models[id].intervals[key].low,
						high: run.models[id].intervals[key].high,
					},
				]),
			),
			bins: run.models[id].calibration_bins.map(
				(b: { count: number }) => b.count,
			),
		})),
	};
});
const oldRows = diagnostics[0].models.C1.rows,
	newRows = diagnostics[1].models.C1.rows;
const cases = oldRows.map(
	(row: { alias: string; uncalibrated_removal_score: number }, i: number) => {
		if (row.alias !== newRows[i].alias)
			throw new Error("Frozen candidate order mismatch");
		return {
			alias: row.alias,
			before: row.uncalibrated_removal_score,
			after: newRows[i].uncalibrated_removal_score,
		};
	},
);
// A09 is the explanatory case already documented in the completed report.
const before = oldRows.find((r: { alias: string }) => r.alias === "A09"),
	after = newRows.find((r: { alias: string }) => r.alias === "A09");
const evidence = LabEvidenceSchema.parse({
	schema: "sortfm.model-lab.v1",
	evaluatedAt: results.evaluated_at,
	resultsSha256: hash(resultsBytes),
	reportSha256: hash(reportBytes),
	diagnosticsSha256: diagnosticsBytes.map(hash),
	runs,
	feedback: {
		beforeTrain: runs[0]!.train,
		afterTrain: runs[1]!.train,
		sample: cases.length,
		cases,
		meanAbsoluteChange:
			cases.reduce(
				(sum: number, c: { before: number; after: number }) =>
					sum + Math.abs(c.after - c.before),
				0,
			) / cases.length,
		explanation: {
			alias: "A09",
			interceptBefore: before.intercept,
			interceptAfter: after.intercept,
			terms: Object.keys(before.contributions).map((feature) => ({
				feature,
				before: before.contributions[feature],
				after: after.contributions[feature],
			})),
		},
	},
});
const output = new URL("../.local/model-lab-evidence.json", import.meta.url);
await mkdir(new URL("../.local/", import.meta.url), {
	recursive: true,
	mode: 0o700,
});
await writeFile(output, JSON.stringify(evidence), { mode: 0o600 });
console.log(
	`Local Model Lab evidence prepared: ${evidence.runs.map((r) => r.train).join(" / ")} training labels; ${evidence.feedback.sample} shared evaluation songs. No account or track identities exported.`,
);
