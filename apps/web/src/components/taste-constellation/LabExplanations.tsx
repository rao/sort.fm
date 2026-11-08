import { PolicyTelemetrySchema } from "@sortfm/contracts";
import type { LabEvidence } from "../../data/model-lab";
import type { QueueItem } from "../../state/review";
import "./explanations.css";

const models = [
	["E1", "Save age", "A simple baseline using time since save."],
	[
		"E2",
		"Metadata & history",
		"Uses metadata, save age and available listening history.",
	],
	["E3", "Metadata + audio", "Adds observed audio descriptors to metadata."],
	[
		"C1",
		"Audio + taste references",
		"Learns from explicit Keep / Remove answers, including distances to their audio centroids.",
	],
	[
		"C2",
		"Chooses the next song",
		"Balances estimated review utility with exploration. Selection scores are separate from removal estimates.",
	],
] as const;

export function ModelGuide() {
	return (
		<details className="lx-guide">
			<summary>
				How the models work{" "}
				<span className="text-caption-1-regular">E1–C1 score · C2 selects</span>
			</summary>
			<div className="lx-models">
				{models.map(([id, name, description]) => (
					<article key={id} data-model={id}>
						<span className="lx-model-id text-title-3-semibold">{id}</span>
						<div>
							<h3 className="text-body-medium">{name}</h3>
							<p className="text-body-2-regular">{description}</p>
						</div>
					</article>
				))}
			</div>
			<p className="lx-model-note text-caption-1-regular">
				All listening fields were missing in frozen E2 runs. Missing audio never
				means dislike. C1 references use training answers only. A library like
				alone is no Keep label; held-out songs never form references.
			</p>
		</details>
	);
}

const metrics = [
	[
		"ROC-AUC",
		"How often a randomly chosen Remove song ranks above a Keep song. 0.5 is chance ranking; 1 is perfect. It measures ranking, not probability calibration. Both classes are needed.",
	],
	[
		"Average precision",
		"Summarizes precision as more Remove songs are retrieved, weighting each recall increase. Higher is better; the Remove fraction is a useful reference. This is not trapezoidal PR-AUC.",
	],
	[
		"Log loss",
		"Scores the probabilities against the actual labels, with a large penalty for confident mistakes. Lower is better. A probability near the wrong extreme is especially costly.",
	],
	[
		"Brier score",
		"The mean squared difference between a removal probability and its 0/1 label. Lower is better; it reflects both discrimination and calibration.",
	],
	[
		"Uncertainty intervals",
		"Show uncertainty in an estimated metric under the stated procedure, not a confidence range for each song. These frozen reports use paired bootstrap resampling of test tracks, conditional on the fitted models; training variation and artist/session dependence are not included.",
	],
] as const;

export function MetricGuide() {
	return (
		<div className="lx-metrics">
			{metrics.map(([name, text]) => (
				<details key={name}>
					<summary className="text-body-2-medium">{name}</summary>
					<p className="text-body-2-regular">{text}</p>
				</details>
			))}
		</div>
	);
}

export function EvidenceGuide() {
	return (
		<details className="lx-evidence">
			<summary>Which kind of evidence am I seeing?</summary>
			<dl className="text-body-2-regular">
				<div>
					<dt>Training result</dt>
					<dd>
						Measured on fitted examples. Useful for diagnosis, not an estimate
						of unseen performance.
					</dd>
				</div>
				<div>
					<dt>Cross-validation</dt>
					<dd>
						Rotates validation folds within the development data. It can guide
						choices, but is not an untouched final test.
					</dd>
				</div>
				<div>
					<dt>Frozen holdout</dt>
					<dd>
						Tests fixed predictions on excluded examples. Once inspected, the
						panel is consumed and cannot be called a fresh test again.
					</dd>
				</div>
				<div>
					<dt>Synthetic simulation</dt>
					<dd>
						Invented data tests the software or illustrates a mechanism. It does
						not measure your taste or production effectiveness.
					</dd>
				</div>
				<div>
					<dt>Live behavior</dt>
					<dd>
						Actual served predictions, selections and recorded actions. A review
						outcome is not automatically a measured C2 reward or proof of
						improvement.
					</dd>
				</div>
			</dl>
		</details>
	);
}

export function FeedbackComparison({
	feedback,
	selected,
	onSelect,
}: {
	feedback: LabEvidence["feedback"];
	selected: number;
	onSelect: (index: number) => void;
}) {
	const scaleX = (v: number) => 64 + v * 400;
	const scaleY = (v: number) => 290 - v * 240;
	return (
		<figure className="lx-feedback">
			<figcaption className="text-body-medium">
				Same songs. Two frozen models.
			</figcaption>
			<p className="text-caption-1-regular">
				Each point is an anonymous recorded case. Above the diagonal means the
				later model estimated more removal; below means less. Select a point to
				inspect its replay.
			</p>
			{/* biome-ignore lint/a11y/useSemanticElements: This SVG chart is an interactive group of measured points, not an HTML fieldset. */}
			<svg
				viewBox="0 0 520 360"
				role="group"
				aria-label="Stored removal estimates before and after additional feedback"
			>
				<title>Recorded C1 prediction changes; no live training</title>
				{[0, 0.5, 1].map((v) => (
					<g key={v} className="lx-grid">
						<line x1={64} x2={464} y1={scaleY(v)} y2={scaleY(v)} />
						<line y1={50} y2={290} x1={scaleX(v)} x2={scaleX(v)} />
						<text x={scaleX(v)} y={312} textAnchor="middle">
							{v * 100}%
						</text>
						<text x={52} y={scaleY(v) + 4} textAnchor="end">
							{v * 100}%
						</text>
					</g>
				))}
				<line className="lx-diagonal" x1={64} y1={290} x2={464} y2={50} />
				<text x={264} y={344} textAnchor="middle">
					{feedback.beforeTrain} labels · before
				</text>
				<text x={12} y={28}>
					{feedback.afterTrain} labels · after
				</text>
				{feedback.cases.map((c, index) => (
					// biome-ignore lint/a11y/useSemanticElements: Interactive SVG marks need button roles and keyboard handling.
					<circle
						key={c.alias}
						role="button"
						tabIndex={0}
						aria-pressed={index === selected}
						aria-label={`${c.alias}: ${(c.before * 100).toFixed(1)}% before, ${(c.after * 100).toFixed(1)}% after`}
						cx={scaleX(c.before)}
						cy={scaleY(c.after)}
						r={index === selected ? 8 : 5}
						className="lx-point"
						data-selected={index === selected}
						onClick={() => onSelect(index)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onSelect(index);
							}
						}}
					>
						<title>{c.alias}</title>
					</circle>
				))}
			</svg>
			<p className="text-caption-1-regular">
				Movement is a change in prediction, not evidence of improved
				generalization. Evaluation labels and song identities are not displayed.
			</p>
		</figure>
	);
}

export function PolicyStrategyBadge({
	strategy,
}: {
	strategy: "explore" | "exploit";
}) {
	return (
		<span
			className="lx-policy-badge text-caption-1-semibold"
			data-strategy={strategy}
		>
			{strategy === "explore" ? "↗ Exploration" : "◎ Exploitation"}
		</span>
	);
}

export function PolicySelection({ item }: { item: QueueItem | undefined }) {
	const parsed = PolicyTelemetrySchema.safeParse(
		item?.exposure.policyTelemetry,
	);
	if (!parsed.success || item?.track.source !== "spotify") return null;
	const data = parsed.data;
	return (
		<section
			className="lx-policy"
			aria-label="Actual policy selection telemetry"
		>
			<PolicyStrategyBadge strategy={data.strategy} />
			<p className="text-body-2-regular">
				{data.strategy === "explore"
					? "This saved selection favored exploration."
					: "This saved selection favored estimated review utility."}
			</p>
			<dl className="lx-policy-counts text-caption-1-regular">
				<div>
					<dt>Candidate pool</dt>
					<dd>{data.candidateCount.toLocaleString()}</dd>
				</div>
				<div>
					<dt>Available</dt>
					<dd>{data.availableCount.toLocaleString()}</dd>
				</div>
				<div>
					<dt>Eligible</dt>
					<dd>{data.eligibleCount.toLocaleString()}</dd>
				</div>
			</dl>
			<details>
				<summary className="text-body-2-medium">Selection context</summary>
				<dl className="ml-readings">
					<div>
						<dt>Design uncertainty</dt>
						<dd>{data.uncertainty.toFixed(3)}</dd>
					</div>
					<div>
						<dt>Information gain</dt>
						<dd>{data.informationGain.toFixed(3)}</dd>
					</div>
					<div>
						<dt>Feedback revision</dt>
						<dd>{data.modelFeedbackRevision}</dd>
					</div>
					<div>
						<dt>Context</dt>
						<dd>
							<code>{data.contextVersion}</code>
						</dd>
					</div>
					<div>
						<dt>Reservation snapshot</dt>
						<dd>{data.reservation.status}</dd>
					</div>
				</dl>
				<p className="text-caption-1-regular">
					Evaluated {new Date(data.reservation.evaluatedAt).toLocaleString()}.
					The snapshot may no longer reflect the current reservation state.
					Design uncertainty is not calibrated confidence; observed rewards are
					not supplied here.
				</p>
			</details>
		</section>
	);
}
