import {
	RiHeartLine,
	RiCloseLine,
	RiQuestionLine,
	RiArrowGoBackLine,
	RiRefreshLine,
} from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import { cx } from "#ui/utils/cx";
import type { ViewProps } from "../Calibration";
import { calibrationLocked } from "../../state/calibration";
import { Cover, EmptyState } from "../ui";
import { MusicLoading } from "../MusicLoading";
import { PreferenceCard } from "./PreferenceCard";
import { synchronization } from "./status";
import "./teach.css";

export function TeachView({
	state,
	onAction,
	onRefresh,
	onRetry,
	onUndo,
	onShowSkipped,
}: ViewProps) {
	// Public presentation is never permitted to render a research-session snapshot.
	if (state.session !== "ordinary")
		return (
			<EmptyState title="Your teaching session is unavailable">
				<p>Return to Teach to load your ordinary preferences.</p>
			</EmptyState>
		);
	const locked = calibrationLocked(state),
		reading = state.loading || state.busy || state.refreshing;
	const current = state.queue[0],
		status = state.teaching?.status ?? null;
	const confirmedRevision = Math.max(
		0,
		...state.history.map((h) => h.feedbackRevision),
	);
	const latest = state.history.find((h) => h.canUndo && h.state === "active");
	return (
		<div className="workspace calibration-workspace teach-workspace">
			<div className="workspace-heading">
				<div>
					<span className="eyebrow">A LITTLE MORE YOU</span>
					<h1>Teach sort.fm</h1>
					<p>Your taste changes. Help us keep up.</p>
				</div>
			</div>
			<div className="calibration-banner">
				<span>
					<RiHeartLine aria-hidden="true" size={18} />
					<strong>Spotify stays unchanged.</strong> Saves preferences only.
				</span>
			</div>
			{(state.error || state.refreshError) && (
				<section className="inline-error calibration-recovery" role="alert">
					<p>{state.refreshError ?? state.error}</p>
					<div className="playback-actions">
						<Button variant="secondary" disabled={reading} onClick={onRefresh}>
							{state.pending ? "Check saved answer" : "Refresh Teach"}
						</Button>
						{state.pending && (
							<Button variant="secondary" disabled={reading} onClick={onRetry}>
								Retry saved request
							</Button>
						)}
					</div>
					<p className="fine-print">
						An unfinished answer keeps its original request key. Nothing is
						resent automatically.
					</p>
				</section>
			)}
			{state.notice && (
				<output className="calibration-notice">{state.notice}</output>
			)}
			<div className="workspace-grid">
				<section className="review-column" aria-label="Teach your preferences">
					<div className="queue-overline">
						<span>
							<i className="status-dot" />A FRESH LISTEN
						</span>
						<span>
							{state.ready
								? `${state.queue.length} ready to revisit`
								: "Connecting…"}
						</span>
					</div>
					{!state.ready && (state.loading || !state.error) ? (
						<MusicLoading message="Finding a fresh listen." />
					) : !state.ready ? (
						<EmptyState
							title={
								state.loading
									? "Finding a little variety"
									: "Your teaching queue is unavailable"
							}
						>
							<p>
								{state.loading
									? "Loading eligible songs and your saved preferences…"
									: "Refresh when your connected library is available."}
							</p>
							{!state.loading && (
								<Button
									variant="secondary"
									onClick={onRefresh}
									disabled={reading}
								>
									Retry Teach
								</Button>
							)}
						</EmptyState>
					) : current ? (
						<>
							<PreferenceCard
								key={current.exposure.exposureId}
								item={current}
								busy={locked}
								onAction={onAction}
								teaching
							/>
							<div className="action-buttons calibration-actions teach-actions">
								{(
									[
										{
											action: 1,
											label: "Discard",
											key: "←",
											Icon: RiCloseLine,
											tone: "unlike",
										},
										{
											action: "skip",
											label: "Unsure",
											key: "↑",
											Icon: RiQuestionLine,
											tone: "skip",
										},
										{
											action: 0,
											label: "Keep",
											key: "→",
											Icon: RiHeartLine,
											tone: "keep",
										},
									] as const
								).map(({ action, label, key, Icon, tone }) => (
									<Button
										key={label}
										variant="ghost"
										className={cx("action-button", tone)}
										aria-label={`${label} (${key})`}
										disabled={locked}
										onClick={() => onAction(action)}
									>
										<span className="action-circle">
											<Icon aria-hidden="true" size={23} />
										</span>
										<span>
											{label} <kbd>{key}</kbd>
										</span>
									</Button>
								))}
							</div>
							<p className="review-helper">
								{state.busy
									? "Saving your answer…"
									: "Swipe or use arrow keys · Z to undo"}
							</p>
							<div className="teach-queue-footer">
								<a
									className="text-link"
									href={`https://open.spotify.com/track/${current.track.trackId}`}
									target="_blank"
									rel="noreferrer"
								>
									Listen in Spotify ↗
								</a>
								<Button
									size="small"
									variant="ghost"
									leadingIcon={RiArrowGoBackLine}
									disabled={locked || !latest}
									onClick={() => latest && onUndo(latest.labelId)}
								>
									Undo
								</Button>
							</div>
						</>
					) : (
						<EmptyState
							title={
								state.skipped ? "No rush to decide." : "A good place to pause."
							}
						>
							<p>
								{state.skipped
									? `${state.skipped} songs marked Unsure this session. No new labels were saved for those answers.`
									: "No eligible songs are waiting in this selection. Come back after adding music, or refresh to check again."}
							</p>
							<div className="playback-actions">
								{state.skipped > 0 && (
									<Button
										variant="secondary"
										disabled={locked}
										onClick={onShowSkipped}
									>
										Revisit unsure songs
									</Button>
								)}
								<Button
									variant="secondary"
									disabled={reading || !!state.pending}
									onClick={onRefresh}
								>
									Refresh selection
								</Button>
							</div>
						</EmptyState>
					)}
					<p className="fine-print">
						Scores stay hidden. Unsure skips without saving an answer.
					</p>
				</section>
				<aside className="workspace-aside">
					<section
						className="model-panel teach-feedback"
						aria-label="Saved training feedback"
					>
						<h2>Your feedback</h2>
						<div className="teach-feedback-count">
							<strong className="text-title-1-medium">
								{status?.trainingFeedbackCount.toLocaleString() ?? "—"}
							</strong>
							<span>Training preferences</span>
						</div>
						<p className="fine-print">
							Eligible Keep / Remove answers from Teach and Sort.
						</p>
						<output className="teach-sync" aria-live="polite">
							{synchronization(status, confirmedRevision)}
						</output>
						{state.teaching?.warning && (
							<p className="fine-print">{state.teaching.warning}</p>
						)}
						<Button
							variant="secondary"
							size="small"
							leadingIcon={RiRefreshLine}
							disabled={reading || !!state.pending}
							onClick={onRefresh}
						>
							Refresh feedback
						</Button>
					</section>
					<section className="model-panel teach-guide">
						<h2 className="text-body-medium">Answer guide</h2>
						<dl>
							<div>
								<dt>Keep</dt>
								<dd>Save a Keep preference.</dd>
							</div>
							<div>
								<dt>Discard</dt>
								<dd>Save a Remove preference.</dd>
							</div>
							<div>
								<dt>Unsure</dt>
								<dd>Skip. No answer saved.</dd>
							</div>
						</dl>
						<p className="fine-print">
							Undo withdraws an answer. Only Sort changes your library.
						</p>
					</section>
				</aside>
			</div>
			<section className="calibration-history">
				<div className="section-top">
					<h2>Your recent teaching</h2>
					<span>Saved preferences</span>
				</div>
				{state.history.length ? (
					<div className="history-list">
						{state.history.slice(0, 10).map((result) => {
							const track = state.tracks[result.trackId];
							return (
								<article className="history-row" key={result.labelId}>
									{track ? (
										<Cover track={track} />
									) : (
										<span className="missing-cover">
											<RiHeartLine aria-hidden="true" />
										</span>
									)}
									<div className="history-song">
										<h3>{track?.title ?? "Saved preference"}</h3>
										<p>
											{track?.artists.map((a) => a.name).join(", ") ??
												new Date(result.createdAt).toLocaleDateString()}
										</p>
									</div>
									<span className="decision-tag">
										{result.submittedLabel === 0 ? "Keep" : "Discard"}{" "}
										·{" "}
										{result.state === "active"
											? "saved"
											: result.state === "revoked"
												? "undone"
												: "replaced"}
									</span>
									<Button
										variant="ghost"
										size="small"
										disabled={
											locked || !result.canUndo || result.state !== "active"
										}
										onClick={() => onUndo(result.labelId)}
									>
										Undo
									</Button>
								</article>
							);
						})}
					</div>
				) : (
					<p className="fine-print">Your confirmed answers will appear here.</p>
				)}
				<p className="fine-print">
					This is recent teaching history. Sort decisions stay in History. The
					training count includes eligible feedback from both.
				</p>
			</section>
		</div>
	);
}
