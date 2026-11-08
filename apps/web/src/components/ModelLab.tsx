import type { ProjectionCache } from "./taste-constellation/history";
import { Batch3Evaluation } from "./Batch3Evaluation";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "#ui/components/base/buttons/button";
import {
	RiFlaskLine,
	RiRefreshLine,
	RiUpload2Line,
	RiArrowRightLine,
} from "@remixicon/react";
import type { ReviewState } from "../state/review";
import {
	LabEvidenceSchema,
	labMetricKeys,
	liveDistribution,
	policyOutcomes,
	readPolicy,
	type LabEvidence,
} from "../data/model-lab";
import "../styles/model-lab.css";
import "../styles/scrollbars.css";
const TasteConstellation = lazy(() =>
	import("./taste-constellation/TasteConstellation").then((module) => ({
		default: module.TasteConstellation,
	})),
);
import {
	ModelGuide,
	MetricGuide,
	EvidenceGuide,
	FeedbackComparison,
	PolicySelection,
	PolicyStrategyBadge,
} from "./taste-constellation/LabExplanations";

const modelNames = {
	E1: "Save age",
	E2: "Metadata / history",
	E3: "Metadata + audio",
	C1: "Audio + taste centroids",
};
const metricNames = {
	roc_auc: "ROC-AUC ↑",
	average_precision: "Avg. precision ↑",
	log_loss: "Log loss ↓",
	brier: "Brier ↓",
};
const number = (n: number | null | undefined) =>
	n == null ? "—" : n.toLocaleString();
const decimal = (n: number | null | undefined) =>
	n == null ? "—" : n.toFixed(3);
const percent = (n: number) => `${(n * 100).toFixed(1)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}`;

function Histogram({ bins, label }: { bins: number[]; label: string }) {
	const max = Math.max(1, ...bins);
	const ranges = ["0–33", "33–67", "67–100"];
	return (
		<figure className="ml-histogram">
			<figcaption>{label}</figcaption>
			{bins.map((n, i) => (
				<div className="ml-bin" key={ranges[i]}>
					<span>{ranges[i]}</span>
					<div aria-hidden="true">
						<i style={{ width: `${(n / max) * 100}%` }} />
					</div>
					<strong>{n}</strong>
				</div>
			))}
			<p>
				Uncalibrated removal estimates, in percent. Range labels are rounded;
				lower scores lean Keep.
			</p>
		</figure>
	);
}
function Counts({ values }: { values: [string, number | null | undefined][] }) {
	return (
		<dl className="ml-counts">
			{values.map(([label, value]) => (
				<div key={label}>
					<dt>{label}</dt>
					<dd>{number(value)}</dd>
				</div>
			))}
		</dl>
	);
}
function Empty({ children }: { children: React.ReactNode }) {
	return <div className="ml-empty">{children}</div>;
}

export function ModelLab({
	state,
	projectionCache,
	onRefresh,
	onRetrain,
}: {
	state: ReviewState;
	projectionCache?: ProjectionCache;
	onRefresh?: () => void;
	onRetrain?: () => void;
}) {
	const live = state.bootstrap?.session.mode === "spotify";
	const [tab, setTab] = useState(live ? "live" : "research");
	const [evidence, setEvidence] = useState<LabEvidence | null>(null);
	const [fileError, setFileError] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const [cohort, setCohort] = useState<"current159" | "original52">(
		"current159",
	);
	const [model, setModel] = useState<keyof typeof modelNames>("C1");
	const [after, setAfter] = useState(false);
	const [caseIndex, setCaseIndex] = useState(8);
	useEffect(() => {
		if (
			!import.meta.env.DEV ||
			!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
		)
			return;
		const controller = new AbortController();
		void fetch("/__local/model-lab", {
			signal: controller.signal,
			cache: "no-store",
		})
			.then(async (response) => {
				if (!response.ok) return;
				const parsed = LabEvidenceSchema.safeParse(await response.json());
				if (parsed.success) setEvidence(parsed.data);
			})
			.catch(() => {});
		return () => controller.abort();
	}, []);
	const run = evidence?.runs.find((r) => r.id === cohort);
	const selectedModel = run?.models.find((m) => m.id === model);
	const distribution = liveDistribution(state);
	const metrics = live ? state.bootstrap?.metrics : null;
	const policy = live ? readPolicy(state.queue[0]) : null;
	const outcomes = live ? policyOutcomes(state) : [];
	const feedback = evidence?.feedback;
	const example =
		feedback?.cases[Math.min(caseIndex, feedback.cases.length - 1)];
	const locked =
		state.busy || state.retraining || state.refreshing || !!state.retry;
	const loadFile = async (file: File | undefined) => {
		if (!file) return;
		try {
			if (file.size > 512_000) throw new Error();
			const result = LabEvidenceSchema.parse(JSON.parse(await file.text()));
			setEvidence(result);
			setFileError("");
			setAfter(false);
			setCaseIndex(8);
		} catch {
			setFileError(
				"That file is not a valid Model Lab evidence export. The current report is unchanged.",
			);
		}
	};
	return (
		<div className="model-lab">
			<header className="ml-heading">
				<div>
					<p className="ml-eyebrow">SORT.FM / TEST BENCH</p>
					<h1>
						<RiFlaskLine aria-hidden="true" /> Model Lab
					</h1>
					<p>Your taste, with the workings showing.</p>
				</div>
				<span className="ml-tag">
					{live ? "CONNECTED ACCOUNT" : "LOCAL DEMO"}
				</span>
			</header>
			<nav className="ml-tabs" aria-label="Model Lab sections">
				{[
					["live", "Live model"],
					["research", "Experiments"],
					["feedback", "Feedback"],
					["policy", "C2 activity"],
					["constellation", "Constellation"],
				].map(([id, label]) => (
					<Button
						key={id}
						variant="secondary"
						aria-pressed={tab === id}
						onClick={() => setTab(id!)}
					>
						{label}
					</Button>
				))}
			</nav>
			<ModelGuide />
			{tab === "constellation" && (
				<Suspense
					fallback={<div className="ml-empty">Loading constellation…</div>}
				>
					<TasteConstellation
						key={state.bootstrap?.session.user?.id ?? "anonymous"}
						connected={live}
						projectionCache={projectionCache}
						refreshKey={JSON.stringify(
							state.history.map(({ result }) => [
								result.decisionId,
								result.status,
								result.feedbackRevision,
								result.labelState,
							]),
						)}
					/>
				</Suspense>
			)}
			{tab === "live" && (
				<section className="ml-window">
					<header>
						<h2>01 / Current model</h2>
						<span>{metrics ? "LIVE API SNAPSHOT" : "NOT CONNECTED"}</span>
					</header>
					<div className="ml-body">
						{!live ? (
							<Empty>
								<strong>This draft has no live model attached.</strong>
								<p>
									Demo choices don’t train a model. Use Experiments for the
									measured research walkthrough, or open Model Lab in your
									connected account for live data.
								</p>
							</Empty>
						) : (
							<>
								<p className="ml-version">
									Model <code>{metrics?.modelVersion ?? "not supplied"}</code> ·{" "}
									{metrics?.dataset ?? "unknown dataset"}
								</p>
								<Counts
									values={[
										["Collected labels", metrics?.labeledExamples],
										["Used in training", metrics?.trainedExamples],
										["Evaluation only", metrics?.heldOutExamples],
									]}
								/>
								<p>
									Evaluation class mix: {number(metrics?.heldOutNegative)} Keep
									/ {number(metrics?.heldOutPositive)} Remove. Training class
									mix is not supplied by this endpoint.
								</p>
								<div className="ml-actions">
									<Button
										variant="secondary"
										disabled={locked || !onRefresh}
										leadingIcon={RiRefreshLine}
										onClick={onRefresh}
									>
										Refresh
									</Button>
									<Button
										variant="secondary"
										disabled={
											locked ||
											!!state.refreshError ||
											!!state.retrainError ||
											!onRetrain
										}
										onClick={onRetrain}
									>
										{state.retraining ? "Training…" : "Retrain from feedback"}
									</Button>
								</div>
								<p>
									Existing exposures keep their served scores after retraining.
									Only newly scored exposures can reflect a newer model.
								</p>
								{(state.refreshError || state.retrainError) && (
									<p role="alert">{state.refreshError || state.retrainError}</p>
								)}
								{state.retrainNotice && <output>{state.retrainNotice}</output>}
								{state.warnings.map((w) => (
									<p key={w} className="ml-note">
										{w}
									</p>
								))}
								<div className="ml-split">
									<div>
										<h3>Current-version score distribution</h3>
										{distribution.items.length ? (
											<Histogram
												bins={distribution.bins}
												label={`${distribution.items.length} unique songs in the loaded queue`}
											/>
										) : (
											<Empty>
												No current-version trained probabilities in the loaded
												queue.
											</Empty>
										)}
										<p>
											{distribution.excluded} loaded songs excluded because
											their version or probability is unavailable. This selected
											queue is not a whole-library distribution.
										</p>
									</div>
									<div>
										<h3>Held-out evaluation</h3>
										{metrics?.status === "available" ? (
											<dl className="ml-readings">
												{[
													["ROC-AUC", metrics.rocAuc],
													["PR-AUC", metrics.prAuc],
													["Log loss", metrics.logLoss],
													["Brier", metrics.brierScore],
												].map(([label, value]) => (
													<div key={label}>
														<dt>{label}</dt>
														<dd>{decimal(value as number | null)}</dd>
													</div>
												))}
											</dl>
										) : (
											<Empty>
												{metrics?.reason ?? "No evaluation was supplied."}
											</Empty>
										)}
										<p>
											{metrics?.evaluationMethod}{" "}
											{metrics?.evaluatedAt && (
												<>
													·{" "}
													<time dateTime={metrics.evaluatedAt}>
														{new Date(metrics.evaluatedAt).toLocaleString()}
													</time>
												</>
											)}
										</p>
									</div>
								</div>
								<details open>
									<summary>Why the current song got its score</summary>
									{state.queue[0] ? (
										<>
											<p>
												<strong>{state.queue[0].track.title}</strong> · served
												model{" "}
												<code>{state.queue[0].prediction.modelVersion}</code> ·{" "}
												{state.queue[0].prediction.removalProbability == null
													? "No trained probability"
													: percent(
															state.queue[0].prediction.removalProbability!,
														)}{" "}
												removal estimate
											</p>
											<p>
												Feature contributions explain this saved prediction, not
												causes of your taste. Positive terms push toward Remove;
												negative terms push toward Keep.
											</p>
											{state.queue[0].prediction.explanations.length ? (
												<ul className="ml-explanations">
													{state.queue[0].prediction.explanations.map(
														(e, i) => (
															<li key={`${i}-${e.feature}`}>
																<strong>
																	{e.feature.replaceAll("_", " ")}
																</strong>
																<b>
																	{e.contribution == null
																		? "No contribution supplied"
																		: signed(e.contribution)}
																</b>
																<p>{e.description}</p>
															</li>
														),
													)}
												</ul>
											) : (
												<p>No feature explanations supplied.</p>
											)}
										</>
									) : (
										<p>No song is currently queued.</p>
									)}
								</details>
							</>
						)}
					</div>
				</section>
			)}
			{tab === "research" && (
				<div className="mb-6">
					<Batch3Evaluation />
				</div>
			)}
			{tab === "research" && (
				<section className="ml-window">
					<header>
						<h2>Batch 2 / Historical comparison</h2>
						<span>
							{run ? "MEASURED · FROZEN HOLDOUT" : "AWAITING EVIDENCE"}
						</span>
					</header>
					<div className="ml-body">
						<MetricGuide />
						<EvidenceGuide />
						{!run ? (
							<Empty>
								Load the completed Batch 2 research export to inspect the
								measured E1 / E2 / E3 / C1 comparison.
							</Empty>
						) : (
							<>
								<fieldset
									className="ml-actions"
									aria-label="Measured training cohort"
								>
									{[
										["current159", "159 labels · blinded holdout"],
										["original52", "52 labels · prospective"],
									].map(([id, label]) => (
										<Button
											key={id}
											variant="secondary"
											aria-pressed={cohort === id}
											onClick={() => setCohort(id as typeof cohort)}
										>
											{label}
										</Button>
									))}
								</fieldset>
								<Counts
									values={[
										["Training labels", run.train],
										["Shared test songs", run.test],
										["Test Remove", run.testRemove],
										["Test Keep", run.testKeep],
									]}
								/>
								<p>
									Training: {run.trainKeep} Keep / {run.trainRemove} Remove.{" "}
									{cohort === "original52"
										? "Predictions sealed before any test judgment."
										: "Fixed recipes fitted after collection, before researcher access to test answers."}{" "}
									These two runs share the same test panel; they are not
									independent replications.
								</p>
								<section
									className="ml-table-wrap"
									// biome-ignore lint/a11y/noNoninteractiveTabindex: Named table regions need keyboard focus for scrolling.
									tabIndex={0}
									aria-label="Measured model comparison"
								>
									<table>
										<caption>
											Held-out performance · estimate [95% bootstrap interval]
										</caption>
										<thead>
											<tr>
												<th scope="col">Model</th>
												{labMetricKeys.map((k) => (
													<th scope="col" key={k}>
														{metricNames[k]}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{run.models.map((m) => (
												<tr key={m.id}>
													<th scope="row">
														{m.id}
														<small>{modelNames[m.id]}</small>
													</th>
													{labMetricKeys.map((k) => (
														<td key={k}>
															<strong>{decimal(m.metrics[k].value)}</strong>
															<small>
																[{decimal(m.metrics[k].low)},{" "}
																{decimal(m.metrics[k].high)}]
															</small>
														</td>
													))}
												</tr>
											))}
										</tbody>
									</table>
								</section>
								<aside className="ml-note">
									<strong>No reliable winner on this panel.</strong>
									<p>
										Primary E2 − C1 log-loss difference:{" "}
										{`${run.primaryContrast.value >= 0 ? "+" : ""}${run.primaryContrast.value.toFixed(5)}`}{" "}
										[95% interval {signed(run.primaryContrast.low)},{" "}
										{signed(run.primaryContrast.high)}]. The interval includes
										zero. Retain production C1; E2 remains a simple challenger
										for fresh evaluation.
									</p>
								</aside>
								<details>
									<summary>What the measurements mean</summary>
									<p>
										Remove is the positive class. Average precision is
										noninterpolated, not trapezoidal PR-AUC. Intervals use
										20,000 paired track bootstrap draws, seed 20261107,
										conditional on fixed fitted models. They exclude training
										variation and artist/session dependence. Secondary
										comparisons are not multiplicity-adjusted.
									</p>
									<p>
										The 25-song panel has been consumed for research and remains
										evaluation-only. It cannot be reused as an untouched test.
										All listening fields were missing in these frozen cohorts,
										so E2 used metadata and save age in practice.
									</p>
								</details>
								<div className="ml-split">
									<div>
										<h3>Frozen score distribution</h3>
										<fieldset
											className="ml-actions"
											aria-label="Distribution model"
										>
											{run.models.map((m) => (
												<Button
													key={m.id}
													size="small"
													variant="secondary"
													aria-pressed={model === m.id}
													onClick={() => setModel(m.id)}
												>
													{m.id}
												</Button>
											))}
										</fieldset>
										<Histogram
											bins={selectedModel!.bins}
											label={`${model} · same ${run.test} evaluation songs`}
										/>
									</div>
									<div className="ml-listen">
										<span aria-hidden="true">↳</span>
										<h3>
											More labels.
											<br />
											Different predictions.
										</h3>
										<p>
											Replay how the recorded C1 estimates changed between the
											two frozen training cohorts.
										</p>
										<Button
											variant="secondary"
											trailingIcon={RiArrowRightLine}
											onClick={() => setTab("feedback")}
										>
											Play feedback replay
										</Button>
									</div>
								</div>
							</>
						)}
					</div>
				</section>
			)}
			{tab === "feedback" && (
				<section className="ml-window">
					<header>
						<h2>03 / Feedback replay</h2>
						<span>
							{feedback ? "MEASURED · HISTORICAL" : "AWAITING EVIDENCE"}
						</span>
					</header>
					<div className="ml-body">
						{!feedback || !example ? (
							<Empty>
								Load a research export to replay recorded predictions before and
								after additional feedback.
							</Empty>
						) : (
							<>
								<p>
									Same {feedback.sample} frozen song inputs. C1 fitted with{" "}
									{feedback.beforeTrain} versus {feedback.afterTrain} training
									labels. The extra {feedback.afterTrain - feedback.beforeTrain}{" "}
									labels change the fitted model; the test songs remain
									excluded.
								</p>
								<div className="ml-replay">
									<div>
										<span>TRAINING TAPE</span>
										<strong>
											{after ? feedback.afterTrain : feedback.beforeTrain}
											<small> human labels</small>
										</strong>
										<Button
											variant="secondary"
											aria-pressed={after}
											onClick={() => setAfter(!after)}
										>
											{after
												? "Rewind to before"
												: `Play +${feedback.afterTrain - feedback.beforeTrain} labels`}
										</Button>
									</div>
									<div className="ml-score">
										<span>FROZEN SONG {example.alias}</span>
										<strong>
											{percent(after ? example.after : example.before)}
										</strong>
										<span>estimated chance of Remove</span>
										<div className="ml-score-meter" aria-hidden="true">
											<i
												style={{
													width: percent(
														after ? example.after : example.before,
													),
												}}
											/>
										</div>
										<p>
											{percent(example.before)} → {percent(example.after)} ·{" "}
											{signed((example.after - example.before) * 100)}{" "}
											percentage points
										</p>
									</div>
								</div>
								<FeedbackComparison
									feedback={feedback}
									selected={caseIndex}
									onSelect={setCaseIndex}
								/>
								<div className="ml-actions">
									<Button
										size="small"
										variant="secondary"
										disabled={caseIndex <= 0}
										onClick={() => setCaseIndex(caseIndex - 1)}
									>
										Previous song
									</Button>
									<span>
										{caseIndex + 1} / {feedback.cases.length}
									</span>
									<Button
										size="small"
										variant="secondary"
										disabled={caseIndex >= feedback.cases.length - 1}
										onClick={() => setCaseIndex(caseIndex + 1)}
									>
										Next song
									</Button>
								</div>
								<p>
									Average absolute score change across the panel:{" "}
									<strong>
										{(feedback.meanAbsoluteChange * 100).toFixed(1)} percentage
										points
									</strong>
									. This is a descriptive comparison of two fitted cohorts, not
									a controlled learning curve or proof of improved
									generalization. The button replays saved results; it does not
									train a model.
								</p>
								<details open>
									<summary>
										Inside the change · song {feedback.explanation.alias}
									</summary>
									<p>
										Signed log-odds contributions from the frozen C1 models.
										Positive pushes toward Remove; negative toward Keep.
										Correlated features and scaling affect these terms; they are
										not causal importance scores.
									</p>
									<section
										className="ml-table-wrap"
										// biome-ignore lint/a11y/noNoninteractiveTabindex: Named table regions need keyboard focus for scrolling.
										tabIndex={0}
										aria-label="Measured feature contributions"
									>
										<table>
											<caption>
												Largest contributions for {feedback.explanation.alias}
											</caption>
											<thead>
												<tr>
													<th scope="col">Feature</th>
													<th scope="col">{feedback.beforeTrain} labels</th>
													<th scope="col">{feedback.afterTrain} labels</th>
												</tr>
											</thead>
											<tbody>
												{[...feedback.explanation.terms]
													.sort(
														(a, b) =>
															Math.max(Math.abs(b.before), Math.abs(b.after)) -
															Math.max(Math.abs(a.before), Math.abs(a.after)),
													)
													.slice(0, 6)
													.map((t) => (
														<tr key={t.feature}>
															<th scope="row">
																{t.feature.replaceAll("_", " ")}
															</th>
															<td>{signed(t.before)}</td>
															<td>{signed(t.after)}</td>
														</tr>
													))}
											</tbody>
										</table>
									</section>
									<p>
										Showing the six largest terms; other features and the
										intercept also contribute. Listening fields were unavailable
										in both runs.
									</p>
								</details>
								{live && (
									<p>
										For new feedback, visit <a href="#/calibrate">Teach</a>,
										then refresh Live model to inspect the trained count and
										version.
									</p>
								)}
							</>
						)}
					</div>
				</section>
			)}
			{tab === "policy" && (
				<section className="ml-window">
					<header>
						<h2>04 / C2 activity</h2>
						<span>
							{policy || outcomes.length
								? "RECORDED TELEMETRY"
								: "AWAITING LIVE TELEMETRY"}
						</span>
					</header>
					<div className="ml-body">
						<PolicySelection item={live ? state.queue[0] : undefined} />
						{!policy ? (
							<Empty>
								<strong>No C2 choice supplied for the current song.</strong>
								<p>
									Selections and outcomes appear when the connected API supplies
									C2 telemetry. This view does not activate the policy or
									simulate rewards.
								</p>
							</Empty>
						) : (
							<>
								<div className="ml-policy-choice">
									<strong>
										{policy.strategy === "explore" ? "Explore" : "Exploit"}
									</strong>
									<p>
										{policy.strategy === "explore"
											? "The recorded policy chose exploration."
											: "The recorded policy chose exploitation."}
									</p>
								</div>
								<p>
									Selector <code>{policy.selectionMethod}</code> · state{" "}
									<code>{policy.policyStateVersion}</code> · reward definition{" "}
									<code>{policy.rewardVersion}</code>
								</p>
								<dl className="ml-readings">
									{[
										["Predicted reward", policy.predictedReward],
										["Selection score", policy.selectionScore],
										["Exploration bonus", policy.explorationBonus],
										["Trained rewards", policy.trainedRewards],
									].map(([k, v]) => (
										<div key={k}>
											<dt>{k}</dt>
											<dd>{decimal(v as number)}</dd>
										</div>
									))}
								</dl>
								<p>
									Policy quantities are not classifier probabilities or
									calibrated confidence.
								</p>
								<ul>
									{[...new Set(policy.reasons)].map((reason) => (
										<li key={reason}>{reason}</li>
									))}
								</ul>
							</>
						)}
						<h3>Recorded review outcomes</h3>
						{outcomes.length ? (
							<section
								className="ml-table-wrap"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: Named table regions need keyboard focus for scrolling.
								tabIndex={0}
								aria-label="C2 recorded review outcomes"
							>
								<table>
									<thead>
										<tr>
											<th scope="col">Song</th>
											<th scope="col">Choice</th>
											<th scope="col">Action</th>
											<th scope="col">Status</th>
										</tr>
									</thead>
									<tbody>
										{outcomes.map(({ item, result, policy }) => (
											<tr key={result.decisionId}>
												<th scope="row">{item?.track.title}</th>
												<td>
													<PolicyStrategyBadge strategy={policy.strategy} />
												</td>
												<td>{result.action}</td>
												<td>
													{result.status === "UNDONE"
														? "Undone · label revoked"
														: result.labelState === "active"
															? "Complete · active label"
															: "Complete · no label"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</section>
						) : (
							<p>
								No completed review outcomes linked to a C2 exposure in loaded
								history.
							</p>
						)}
						<p>
							Only exact exposure-linked records in this session are shown. A
							review action is not a learned reward; observed reward values and
							all-time policy totals are not supplied by the current browser
							API. Undone decisions stay marked as revoked.
						</p>
					</div>
				</section>
			)}
			<footer className="ml-provenance">
				<div>
					<strong>
						{evidence
							? "Batch 2 research loaded locally"
							: "Batch 2 research evidence"}
					</strong>
					<p>
						{evidence
							? `Evaluated ${new Date(evidence.evaluatedAt).toLocaleString()}. Kept in this page’s memory; not uploaded or saved in browser storage.`
							: "Load a prepared Batch 2 Model Lab JSON export. Live account data remains separate from frozen research."}
					</p>
				</div>
				<input
					ref={input}
					type="file"
					accept=".json,application/json"
					hidden
					aria-label="Load Model Lab evidence"
					onChange={(e) => {
						void loadFile(e.target.files?.[0]);
						e.target.value = "";
					}}
				/>
				<Button
					variant="secondary"
					size="small"
					leadingIcon={RiUpload2Line}
					onClick={() => input.current?.click()}
				>
					Load evidence
				</Button>
				{fileError && <p role="alert">{fileError}</p>}
				{evidence && (
					<details>
						<summary>Source fingerprints</summary>
						<p>Completed frozen evaluation · SHA-256</p>
						<p>
							Results <code>{evidence.resultsSha256}</code>
						</p>
						<p>
							Report <code>{evidence.reportSha256}</code>
						</p>
						{evidence.diagnosticsSha256.map((hash, i) => (
							<p key={hash}>
								Feature diagnostics {i === 0 ? "52" : "159"} <code>{hash}</code>
							</p>
						))}
					</details>
				)}
			</footer>
		</div>
	);
}
