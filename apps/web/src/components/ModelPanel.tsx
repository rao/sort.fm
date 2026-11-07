import type { ModelMetrics, Prediction } from "@sortfm/contracts";
import { Icon, Progress } from "./ui";
export function PredictionDisplay({
	prediction,
}: {
	prediction: Prediction | null;
}) {
	const probability = prediction?.removalProbability;
	return (
		<div className="prediction-display">
			<div className="eyebrow">REMOVAL ESTIMATE</div>
			<div className="prediction-number">
				{probability != null
					? `${Math.round(probability * 100)}%`
					: "Still getting to know you"}
			</div>
			<p>
				{probability != null
					? "Estimated chance you would choose Archive or Unlike. The choice is yours."
					: "A few honest decisions are the start of a better-fitting library."}
			</p>
			<div className="confidence-scale" aria-hidden="true">
				{Array.from({ length: 24 }, (_, i) => i + 1).map((tick) => (
					<i
						key={tick}
						className={
							probability != null && tick / 24 <= probability ? "filled" : ""
						}
					/>
				))}
			</div>
			<div className="scale-labels">
				<span>{probability != null ? "Keep" : "Prediction unavailable"}</span>
				<span>{probability != null ? "Remove" : "Early learning"}</span>
			</div>
			{prediction?.uncertainty != null && (
				<p className="fine-print">
					Uncertainty: {prediction.uncertainty.toFixed(2)} (
					{prediction.uncertaintyMethod}).{" "}
					{prediction.calibrated
						? "Calibrated estimate."
						: "Not calibrated; limited confidence."}
				</p>
			)}
		</div>
	);
}
export function ModelPanel({
	prediction,
	labeled,
	total,
	metrics,
	live = false,
}: {
	prediction: Prediction | null;
	labeled: number | null;
	total: number;
	metrics: ModelMetrics | null;
	live?: boolean;
}) {
	return (
		<aside className="model-panel">
			<div className="panel-heading">
				<span className="accent-icon">
					<Icon name="spark" size={19} />
				</span>
				<h2>Your taste, in focus</h2>
				<span className="small-badge">
					{prediction?.modelKind ?? "UNAVAILABLE"}
				</span>
			</div>
			<PredictionDisplay prediction={prediction} />
			<div className="model-progress">
				<div>
					<span>Your feedback</span>
					<strong>
						{labeled ?? "Unavailable"} {!live && <span>/ {total}</span>}
					</strong>
				</div>
				{!live && (
					<Progress label="Labeled songs" value={labeled ?? 0} max={total} />
				)}
				<p>
					{live
						? "Persisted model feedback. Skip does not supply a label."
						: `${total - (labeled ?? 0)} songs still unlabeled. Skip does not count as a label.`}
				</p>
			</div>
			<details className="why-song">
				<summary>
					Why this song? <Icon name="plus" size={16} />
				</summary>
				{prediction?.explanations.length ? (
					prediction.explanations.map((explanation) => (
						<p key={explanation.feature}>{explanation.description}</p>
					))
				) : (
					<p>
						{live
							? "No explanation was supplied for this server-selected song. The shown score and version belong to its saved exposure."
							: "This is a curated demo sequence across artists and saved dates. No personalized ranking or trained prediction is active."}
					</p>
				)}
			</details>
			<a className="text-link model-link" href="#/insights">
				Open model inspector <Icon name="arrow" size={16} />
			</a>
			<div className="model-foot">
				<span className="status-dot" />
				{metrics?.trainedExamples
					? `${metrics?.trainedExamples} training examples`
					: metrics
						? "Model not trained"
						: "Metrics unavailable"}
				<span>{metrics?.modelVersion ?? "Metrics unavailable"}</span>
			</div>
		</aside>
	);
}
export function EvaluationEmpty() {
	return (
		<div className="chart-empty">
			<div className="chart-grid" aria-hidden="true" />
			<div>
				<Icon name="chart" size={24} />
				<h3>Not enough data. Yet.</h3>
				<p>
					Real held-out evaluation will appear here when a connected model has
					enough feedback.
				</p>
				<span>No simulated accuracy or learning curve</span>
			</div>
		</div>
	);
}
