import type { AudioFeatureStatus } from "@sortfm/contracts";
import { isEmptyModelEvaluation } from "../data/live-client";
import type { ReviewState } from "../state/review";
import { EvaluationEmpty, PredictionDisplay } from "./ModelPanel";
import { Icon, Progress } from "./ui";
export function Insights({
	state,
	onRetrain,
	onRefresh,
}: {
	state: ReviewState;
	onRetrain?: () => void;
	onRefresh?: () => void;
}) {
	const metrics = state.bootstrap!.metrics;
	const live = state.bootstrap!.session.mode === "spotify";
	const locked =
		state.busy ||
		state.retraining ||
		state.refreshing ||
		!!state.retry ||
		!!state.refreshError ||
		!!state.retrainError;
	const controls = live && (
		<div className="model-controls">
			<div className="playback-actions">
				<button
					type="button"
					className="button secondary small"
					disabled={locked}
					onClick={onRetrain}
				>
					{state.retraining ? "Training model…" : "Retrain model"}
				</button>
				<button
					type="button"
					className="text-button"
					disabled={
						state.busy || state.retraining || state.refreshing || !!state.retry
					}
					onClick={onRefresh}
				>
					Refresh model data
				</button>
			</div>
			<p className="fine-print">
				Fits your persisted feedback. Existing song estimates keep the model
				version used when they were served.
			</p>
			{state.retrainError && (
				<p role="alert" className="inline-error">
					{state.retrainError}
				</p>
			)}
			{state.retrainNotice && (
				<output className="fine-print">{state.retrainNotice}</output>
			)}
		</div>
	);
	if (!metrics)
		return (
			<div className="page">
				<header className="page-heading">
					<h1>Your model is not available yet.</h1>
					<p>
						The library can still be reviewed. Metrics will appear when the
						server supplies them.
					</p>
				</header>
				{controls}
				<section className="surface model-details">
					<h2>Audio enrichment</h2>
					<AudioFeatureDetails audio={state.insights?.audioFeatures} />
				</section>
			</div>
		);
	const labeled = live
		? metrics.labeledExamples
		: state.history.filter(({ result }) => result.labelState === "active")
				.length;
	const total = state.bootstrap!.queue.items.length;
	return (
		<div className="page insights-page">
			<header className="page-heading">
				<span className="eyebrow">THE THINKING BEHIND THE QUEUE</span>
				<a className="text-button" href="#/model">
					Open Model Lab →
				</a>
				<h1>No black boxes. Just your taste.</h1>
				<p>A clear view of what the model knows, and what it doesn't.</p>
			</header>
			{controls}
			<div className="insights-summary">
				<div>
					<span className="accent-icon">
						<Icon name="spark" />
					</span>
					<div>
						<h2>
							{metrics.trainedExamples
								? metrics.modelVersion
								: "A fresh pair of ears"}
						</h2>
						<p>
							{metrics.trainedExamples
								? "Model supplied by the connected API"
								: live
									? "No trained model yet • server-selected queue"
									: "Untrained model • curated demo sequence"}
						</p>
					</div>
				</div>
				<span className="status-label">
					{metrics.trainedExamples
						? "Model available"
						: "Waiting for a connected model"}
				</span>
			</div>
			<div className="insights-grid">
				<section className="surface feedback-surface">
					<h2>Every decision is a signal</h2>
					<div className="large-count">
						{labeled}
						<span>labeled songs</span>
					</div>
					{!live && (
						<Progress value={labeled} max={total} label="Feedback coverage" />
					)}
					<div className="data-row">
						<span>{live ? "Remaining to review" : "Still unlabeled"}</span>
						<strong>{live ? state.remaining : total - labeled}</strong>
					</div>
					<div className="data-row">
						<span>Used for training</span>
						<strong>{metrics.trainedExamples}</strong>
					</div>
					<div className="data-row">
						<span>Held out for evaluation</span>
						<strong>{metrics.heldOutExamples}</strong>
					</div>
					<p className="fine-print">
						Keep supplies a keep label. Archive and Unlike supply a removal
						label. Skip stays unlabeled; Undo revokes the decision.
					</p>
				</section>
				<section className="surface evaluation-surface">
					<div className="section-top">
						<h2>Learning, measured honestly</h2>
						<span className="small-badge">
							{metrics.status === "available"
								? "API EVALUATION"
								: "EVALUATION UNAVAILABLE"}
						</span>
					</div>
					{metrics.status === "available" ? (
						<>
							<div className="metric-values">
								{(
									[
										["Balanced accuracy", metrics.balancedAccuracy, true],
										["ROC-AUC", metrics.rocAuc, false],
										["PR-AUC", metrics.prAuc, false],
										["Log loss", metrics.logLoss, false],
										["Brier score", metrics.brierScore, false],
										["Precision at k", metrics.precisionAtK, false],
										["Removal base rate", metrics.baseRate, true],
									] as const
								).map(([label, value, percentage]) => (
									<div key={label}>
										<strong>
											{value == null
												? "Not supplied"
												: percentage
													? `${(value * 100).toFixed(1)}%`
													: value.toFixed(3)}
										</strong>
										<span>{label}</span>
									</div>
								))}
							</div>
							<p>
								{metrics.evaluationMethod} • {metrics.heldOutExamples} held-out
								examples • {metrics.dataset}
							</p>
						</>
					) : (
						<EvaluationEmpty unavailable={metrics.status === "unavailable"} />
					)}
					<p className="fine-print">{metrics.reason}</p>
					{metrics.evaluatedAt && (
						<p className="fine-print">
							Evaluated{" "}
							<time dateTime={metrics.evaluatedAt}>
								{new Date(metrics.evaluatedAt).toLocaleString()}
							</time>
						</p>
					)}
				</section>
				<section className="surface">
					<h2>The current song</h2>
					<p className="fine-print">
						Saved exposure estimate. It may use an earlier model than the latest
						training run.
					</p>
					<PredictionDisplay prediction={state.queue[0]?.prediction ?? null} />
					{state.queue[0]?.prediction.explanations.map((item) => (
						<div className="feature-explanation" key={item.feature}>
							<strong>{item.feature}</strong>
							<p>{item.description}</p>
							<span className="fine-print">
								Value: {item.value == null ? "Missing" : item.value.toFixed(3)}{" "}
								· Contribution:{" "}
								{item.contribution == null
									? "Not supplied"
									: item.contribution.toFixed(3)}
							</span>
						</div>
					))}
				</section>
				<section className="surface model-details">
					<h2>Under the hood</h2>
					<div className="data-row">
						<span>Current model kind</span>
						<strong>
							{state.insights?.prediction?.modelVersion === metrics.modelVersion
								? state.insights.prediction.modelKind
								: "Not supplied"}
						</strong>
					</div>
					<div className="data-row">
						<span>Training class mix</span>
						<strong>Not supplied by the API</strong>
					</div>
					<div className="data-row">
						<span>Model version</span>
						<code>{metrics.modelVersion}</code>
					</div>
					<div className="data-row">
						<span>Dataset</span>
						<strong>
							{live && isEmptyModelEvaluation(metrics)
								? "No feedback yet"
								: metrics.dataset}
						</strong>
					</div>
					<div className="data-row">
						<span>Selection policy</span>
						<strong>
							{state.queue[0]?.exposure.selectionMethod ?? "Queue complete"}
						</strong>
					</div>
					<AudioFeatureDetails audio={state.insights?.audioFeatures} />
					<div className="data-row">
						<span>Feature ablation comparison</span>
						<strong>No comparison supplied</strong>
					</div>
					<div className="data-row">
						<span>Holdout removal / keep examples</span>
						<strong>
							{metrics.heldOutPositive} / {metrics.heldOutNegative}
						</strong>
					</div>
					<p className="fine-print">
						No training runs or bandit rewards are simulated here. Live
						training, feature contributions, and evaluation come from the ML
						service.
					</p>
				</section>
			</div>
		</div>
	);
}

function AudioFeatureDetails({
	audio,
}: {
	audio: AudioFeatureStatus | undefined;
}) {
	return (
		<>
			<div className="data-row">
				<span>
					{audio
						? { soundnet: "SoundNet", musicae: "Musicae" }[audio.provider]
						: "Audio"}{" "}
					enrichment
				</span>
				<strong>{audio?.status ?? "Not connected"}</strong>
			</div>
			{audio && (
				<>
					<div className="data-row">
						<span>Audio features ready</span>
						<strong>
							{audio.featuresReady} / {audio.featuresTotal}
						</strong>
					</div>
					<div className="data-row">
						<span>Failed enrichment</span>
						<strong>{audio.failed}</strong>
					</div>
					{Object.entries(audio.missingness).map(([feature, missing]) => (
						<div className="feature-completeness" key={feature}>
							<div className="data-row">
								<span>{feature}</span>
								<strong>{Math.round((1 - missing) * 100)}% present</strong>
							</div>
							<Progress
								label={`${feature} completeness`}
								value={1 - missing}
								max={1}
							/>
						</div>
					))}
					<p className="fine-print">{audio.reason}</p>
				</>
			)}
		</>
	);
}
