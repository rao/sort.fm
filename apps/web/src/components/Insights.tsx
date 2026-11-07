import type { ReviewState } from "../state/review";
import { EvaluationEmpty, PredictionDisplay } from "./ModelPanel";
import { Icon, Progress } from "./ui";
export function Insights({ state }: { state: ReviewState }) {
	const metrics = state.bootstrap!.metrics;
	const live = state.bootstrap!.session.mode === "spotify";
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
				<h1>No black boxes. Just your taste.</h1>
				<p>A clear view of what the model knows, and what it doesn't.</p>
			</header>
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
								<div>
									<strong>
										{((metrics.balancedAccuracy ?? 0) * 100).toFixed(1)}%
									</strong>
									<span>Balanced accuracy</span>
								</div>
								<div>
									<strong>{metrics.rocAuc?.toFixed(3)}</strong>
									<span>ROC-AUC</span>
								</div>
								<div>
									<strong>{metrics.brierScore?.toFixed(3)}</strong>
									<span>Brier score</span>
								</div>
							</div>
							<p>
								{metrics.evaluationMethod} • {metrics.heldOutExamples} held-out
								examples • {metrics.dataset}
							</p>
						</>
					) : (
						<EvaluationEmpty />
					)}
					<p className="fine-print">{metrics.reason}</p>
				</section>
				<section className="surface">
					<h2>The current song</h2>
					<PredictionDisplay prediction={state.queue[0]?.prediction ?? null} />
				</section>
				<section className="surface model-details">
					<h2>Under the hood</h2>
					<div className="data-row">
						<span>Model version</span>
						<code>{metrics.modelVersion}</code>
					</div>
					<div className="data-row">
						<span>Dataset</span>
						<strong>{metrics.dataset}</strong>
					</div>
					<div className="data-row">
						<span>Selection policy</span>
						<strong>
							{state.queue[0]?.exposure.selectionMethod ?? "Queue complete"}
						</strong>
					</div>
					<div className="data-row">
						<span>SoundNet enrichment</span>
						<strong>
							{state.insights?.audioFeatures.status ?? "Not connected"}
						</strong>
					</div>
					<div className="data-row">
						<span>Feature comparison</span>
						<strong>No comparison supplied</strong>
					</div>
					{state.insights && (
						<>
							<div className="data-row">
								<span>Audio features ready</span>
								<strong>
									{state.insights.audioFeatures.featuresReady} /{" "}
									{state.insights.audioFeatures.featuresTotal}
								</strong>
							</div>
							<p className="fine-print">
								{state.insights.audioFeatures.reason}
							</p>
						</>
					)}
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
