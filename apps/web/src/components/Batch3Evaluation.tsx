// Authorized aggregate-only transcription of the completed frozen evaluation.
// Source: evaluation-report-v1/report.md and source-hashes.json (8 Nov 2026).
// Private outcomes, track identities, and model artifacts must not be bundled.
const metricsSha256 =
	"d63dd93c1f0dbf3e4c7886d28c6bf4c4aae4a064cdcbd64d934226cc4e0dc3d0";

const results = [
	{
		model: "E2",
		name: "Metadata / history",
		values: ["0.739", "0.694", "0.645", "0.230"],
	},
	{
		model: "C1",
		name: "Audio + taste centroids",
		values: ["0.780", "0.707", "0.605", "0.211"],
	},
] as const;

/** Frozen research evidence, independent of live metrics and demo fixtures. */
export function Batch3Evaluation() {
	return (
		<section className="ml-window" aria-labelledby="batch3-title">
			<header>
				<h2 id="batch3-title">Batch 3 / The latest evaluation</h2>
				<span>LATEST · FROZEN PROSPECTIVE</span>
			</header>
			<div className="ml-body">
				<p>
					Two models frozen before outcome collection, evaluated on the same 40
					randomly held-out songs. Completed 8 November 2026.
				</p>
				<dl className="ml-counts">
					{[
						["Training labels", 159],
						["Random held-out songs", 40],
						["Held-out Keep", 26],
						["Held-out Remove", 14],
					].map(([label, count]) => (
						<div key={label}>
							<dt>{label}</dt>
							<dd>{count}</dd>
						</div>
					))}
				</dl>
				<section
					className="ml-table-wrap"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: Named table regions need keyboard focus for scrolling.
					tabIndex={0}
					aria-label="Batch 3 frozen model comparison"
				>
					<table>
						<caption>Frozen held-out performance · point estimates</caption>
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col">ROC-AUC ↑</th>
								<th scope="col">Average precision ↑</th>
								<th scope="col">Log loss ↓</th>
								<th scope="col">Brier ↓</th>
							</tr>
						</thead>
						<tbody>
							{results.map(({ model, name, values }) => (
								<tr key={model}>
									<th scope="row">
										{model}
										<small>{name}</small>
									</th>
									{values.map((value, index) => (
										<td key={["auc", "ap", "logLoss", "brier"][index]}>
											<strong>{value}</strong>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</section>
				<aside className="ml-note">
					<strong>
						Encouraging point estimates; superiority is not established.
					</strong>
					<p>
						C1 had better point estimates across all four metrics, but all four
						paired 95% intervals include zero.
					</p>
					<p>
						C1 − E2 log-loss difference: <strong>−0.0398</strong>, 95% CI{" "}
						<strong>[−0.0927, +0.0178]</strong>. Negative favors C1; the
						interval also allows an E2 advantage. This does not establish
						equivalence.
					</p>
				</aside>
				<p>
					Batch 2 and Batch 3 use different song panels. Changes between their
					metrics are not evidence of model learning or a controlled
					improvement.
				</p>
				<p>
					This research outcome panel is consumed and permanently excluded from
					training. It cannot be reused as an untouched test. Production C1
					remains unchanged.
				</p>
				<details>
					<summary>Source and evaluation boundaries</summary>
					<p>
						Source: completed Batch 3 frozen evaluation, evaluation-report-v1, 8
						November 2026. Authorized aggregate results only; no song identities
						or individual outcomes are included here.
					</p>
					<p>
						Remove is the positive class. Average precision is not trapezoidal
						PR-AUC. Intervals use 20,000 paired track-bootstrap draws, seed
						20261109, conditional on the frozen models. They omit fitting
						uncertainty and artist/session dependence. This single-listener
						panel does not establish generalization to other listeners. No
						fitting, tuning, or promotion was performed by this evaluation.
					</p>
					<p>
						Metrics source SHA-256:{" "}
						<code className="break-all">{metricsSha256}</code>
					</p>
				</details>
			</div>
		</section>
	);
}
