import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type PointerEvent,
} from "react";
import type {
	CalibrationStore,
	CalibrationState,
	CalibrationAction,
} from "../state/calibration";
import {
	calibrationActionFromDrag,
	calibrationActionFromKey,
	calibrationLocked,
} from "../state/calibration";
import { Cover, EmptyState, Icon, duration, savedDate } from "./ui";

export function CalibrationWorkspace({
	store,
}: {
	store: CalibrationStore | null;
}) {
	if (!store)
		return (
			<EmptyState title="Calibration needs your connected library">
				<p>
					Preference labels are saved to your account. Demo songs cannot be used
					as personal training data.
				</p>
				<a className="button primary" href="/#/calibrate">
					Connect Spotify
				</a>
				<a className="button secondary" href="?mode=demo#/review">
					Continue demo sorting
				</a>
			</EmptyState>
		);
	return <ConnectedCalibration store={store} />;
}
function ConnectedCalibration({ store }: { store: CalibrationStore }) {
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	useEffect(() => {
		void store.refresh();
	}, [store]);
	const act = (action: CalibrationAction) => {
		if (action === "skip") store.skip();
		else if (action === "undo") {
			const latest = store
				.getSnapshot()
				.history.find((item) => item.canUndo && item.state === "active");
			if (latest) void store.undo(latest.labelId);
		} else void store.label(action);
	};
	useEffect(() => {
		function keydown(event: KeyboardEvent) {
			if (
				event.repeat ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				document.querySelector('[role="dialog"],dialog[open]') ||
				(event.target as HTMLElement | null)?.closest(
					"input,textarea,select,button,a,summary,[contenteditable=true]",
				)
			)
				return;
			const action = calibrationActionFromKey(event.key);
			if (action === null) return;
			event.preventDefault();
			if (action === "skip") store.skip();
			else if (action === "undo") {
				const latest = store
					.getSnapshot()
					.history.find((item) => item.canUndo && item.state === "active");
				if (latest) void store.undo(latest.labelId);
			} else void store.label(action);
		}
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [store]);
	return (
		<CalibrationView
			state={state}
			onAction={act}
			onRefresh={() => void store.refresh()}
			onRetry={() => void store.retry()}
			onUndo={(id) => void store.undo(id)}
			onRetrain={() => void store.retrain()}
			onShowSkipped={() => void store.showSkipped()}
   onSession={(session,seed)=>void store.selectSession(session,seed)}
		/>
	);
}
type ViewProps = {
 onSession?:(session:"ordinary"|"batch2",seed?:number)=>void;
	state: CalibrationState;
	onAction: (action: CalibrationAction) => void;
	onRefresh: () => void;
	onRetry: () => void;
	onUndo: (id: string) => void;
	onRetrain: () => void;
	onShowSkipped: () => void;
};
export function CalibrationView({
	state,
	onAction,
	onRefresh,
	onRetry,
	onUndo,
	onRetrain,
	onShowSkipped,
 onSession,
}: ViewProps) {
	const [seed,setSeed]=useState(42);
 const locked = calibrationLocked(state);
	const reading =
		state.loading || state.busy || state.refreshing || state.retraining;
	const current = state.queue[0];
	const active = state.history.filter((item) => item.state === "active");
	return (
		<div className="workspace calibration-workspace">
			<div className="workspace-heading">
				<div>
					<span className="eyebrow">TEACH YOUR TASTE · LABELS ONLY</span>
					<h1>Start with a feeling.</h1>
					<p>
						Would you keep this song today? Your answers teach your preferences. Your
						Spotify library stays unchanged.
					</p>
				</div>
			</div>
            <section className="calibration-banner" aria-label="Calibration session">
                <div>
                    <div className="playback-actions">
                        <button type="button" className="button secondary small" aria-pressed={state.session==="ordinary"} disabled={state.busy||state.loading||state.refreshing||state.retraining||!!state.pending} onClick={()=>onSession?.("ordinary")}>Open calibration</button>
                        <button type="button" className="button secondary small" aria-pressed={state.session==="batch2"} disabled={state.busy||state.loading||state.refreshing||state.retraining||!!state.pending} onClick={()=>onSession?.("batch2",seed)}>Start / resume Batch 2</button>
                        {!state.batch && <label className="fine-print">Sampling seed <input aria-label="Batch 2 sampling seed" type="number" min="0" max="2147483647" value={seed} disabled={reading||!!state.pending} onChange={e=>{const value=Number(e.target.value);if(Number.isInteger(value)&&value>=0&&value<=2147483647)setSeed(value);}} /></label>}
                    </div>
                    {state.batch ? <>
                        <p><strong>Batch 2 · {state.batch.labeled} / 70 labels saved</strong></p>
                        <p className="fine-print">{state.batch.trainingLabeled} / 45 training labels · {state.batch.sealedLabeled} / 25 sealed evaluation labels. Evaluation labels stay outside training and routine model metrics.</p>
                        <p className="fine-print">Your selection is saved. Skip records no preference and requests a replacement from the same group.</p>
                    </> : <p className="fine-print">Batch 2 saves 70 songs: 25 random, 25 diverse, and 20 uncertain. It resumes the same selection after refresh.</p>}
                </div>
            </section>
			<div className="calibration-banner">
				<span>
					<Icon name="spark" size={17} />
					<strong>Your instinct comes first.</strong> Predictions are hidden
					while you label.
				</span>
			</div>
			{(state.error || state.refreshError || state.retrainError) && (
				<section className="inline-error calibration-recovery" role="alert">
					<p>{state.refreshError ?? state.error ?? state.retrainError}</p>
					<div className="playback-actions">
						<button
							type="button"
							className="button secondary small"
							disabled={reading}
							onClick={onRefresh}
						>
							{state.pending
								? "Check saved label outcome"
								: "Refresh calibration"}
						</button>
						{state.pending && (
							<button
								type="button"
								className="button secondary small"
								disabled={reading}
								onClick={onRetry}
							>
								Retry original {state.pending.kind}
							</button>
						)}
					</div>
					<p className="fine-print">
						Recovery uses calibration history and the original request key. It
						never changes Spotify.
					</p>
				</section>
			)}
			{state.notice && (
				<output className="calibration-notice">{state.notice}</output>
			)}
			<div className="workspace-grid">
				<section className="review-column" aria-label="Label preferences">
					<div className="queue-overline">
						<span>
							<i className="status-dot" />
							PREFERENCE CALIBRATION
						</span>
						<span>
							{state.ready ? `${state.queue.length} loaded` : "Connecting…"}
						</span>
					</div>
					{!state.ready ? (
						<EmptyState
							title={
								state.loading
									? "Finding a little variety"
									: "Calibration is unavailable"
							}
						>
							<p>
								{state.loading
									? "Loading your imported songs and saved labels…"
									: "Labeling stays paused until the dedicated calibration service is available."}
							</p>
							{!state.loading && (
								<button
									type="button"
									className="button secondary"
									disabled={reading}
									onClick={onRefresh}
								>
									Retry calibration
								</button>
							)}
						</EmptyState>
					) : current ? (
						<>
							<CalibrationCard
								key={current.exposure.exposureId}
								item={current}
								busy={locked}
								onAction={onAction}
							/>
							<div className="action-buttons calibration-actions">
								{(
									[
										[1, "Would remove", "←", "close"],
										["skip", "Skip", "↑", "skip"],
										[0, "Would keep", "→", "heart"],
									] as const
								).map(([action, label, key, icon]) => (
									<button
										type="button"
										key={label}
										className={`action-button ${action === 0 ? "keep" : action === 1 ? "unlike" : "skip"}`}
										aria-label={`${label} (${key})`}
										disabled={locked}
										onClick={() => onAction(action)}
									>
										<span className="action-circle">
											<Icon name={icon} size={23} />
										</span>
										<span>
											{label} <kbd>{key}</kbd>
										</span>
									</button>
								))}
							</div>
							<p className="review-helper">
								{state.busy
									? "Saving your label…"
									: "Swipe left / right to label, up to skip. Z undoes a label."}
							</p>
							<a
								className="text-link"
								href={`https://open.spotify.com/track/${current.track.trackId}`}
								target="_blank"
								rel="noreferrer"
							>
								Open song in Spotify <Icon name="external" size={14} />
							</a>
						</>
					) : (
						<EmptyState
							title={
								state.batch ? (state.batch.labeled===70?"Batch 2 is complete":"No replacement available") : state.skipped
									? "A little room to reconsider"
									: "This selection is complete"
							}
						>
							<p>
								{state.batch ? `${state.batch.labeled} of 70 preference labels saved. Skipped songs remain unlabeled.` : state.skipped
									? `${state.skipped} songs skipped locally. No labels were saved for those skips.`
									: `${state.remaining ?? 0} eligible songs remain on the server.`}
							</p>
							{state.skipped > 0 && !state.batch && (
								<button
									type="button"
									className="button secondary"
									disabled={locked}
									onClick={onShowSkipped}
								>
									Show skipped songs
								</button>
							)}
							<button
								type="button"
								className="button secondary"
								disabled={reading || !!state.pending}
								onClick={onRefresh}
							>
								Refresh selection
							</button>
						</EmptyState>
					)}
					{state.fallbackReason && (
						<p className="fine-print">{state.fallbackReason}</p>
					)}
					<p className="fine-print">
						{state.batch ? "Batch skips are saved and replaced within their original group." : "Skip is local to this session."} Labels and Undo never save, remove, or archive a Spotify song.
					</p>
				</section>
				<aside className="workspace-aside">
					<section className="model-panel">
						<div className="panel-heading">
							<span className="accent-icon">
								<Icon name="spark" />
							</span>
							<h2>Your feedback, honestly.</h2>
						</div>
						<div className="data-row">
							<span>Active labels in loaded history</span>
							<strong>{state.ready ? active.length : "Unavailable"}</strong>
						</div>
						<div className="data-row">
							<span>Would keep / would remove</span>
							<strong>
								{state.ready
									? `${active.filter((item) => item.label === 0).length} / ${active.filter((item) => item.label === 1).length}`
									: "Unavailable"}
							</strong>
						</div>
						<div className="data-row">
							<span>Personal model feedback, all sources</span>
							<strong>{state.metrics?.labeledExamples ?? "Unavailable"}</strong>
						</div>
						<div className="data-row">
							<span>Used for training</span>
							<strong>{state.metrics?.trainedExamples ?? "Unavailable"}</strong>
						</div>
						<div className="data-row">
							<span>Held out by the service</span>
							<strong>{state.metrics?.heldOutExamples ?? "Unavailable"}</strong>
						</div>
						<p className="fine-print">
							Model: <code>{state.metrics?.modelVersion ?? "Unavailable"}</code>
						</p>
						<p className="fine-print">
							Saved labels may take a moment to reach the model. Counts above
							are server-confirmed, not predictions about this song.
						</p>
						{state.modelWarning && (
							<output className="inline-error">
								{state.modelWarning}
							</output>
						)}
						<button
							type="button"
							className="button secondary wide"
							disabled={locked || !!state.retrainError}
							onClick={onRetrain}
						>
							{state.retraining
								? "Training model…"
								: "Retrain from saved feedback"}
						</button>
						<button
							type="button"
							className="text-button"
							disabled={reading}
							onClick={onRefresh}
						>
							Refresh model data
						</button>
						<p className="fine-print">
							{state.batch ? "Batch 2 reserves 25 random songs for later evaluation. Those labels never enter C1 fitting or routine evaluation metrics." : "This is an online selection across your library. It is not the offline sealed evaluation cohort."}
						</p>
					</section>
				</aside>
			</div>
			<section className="calibration-history">
				<div className="section-top">
					<h2>Calibration label history</h2>
					<span>
						{state.historyHasMore ? "Recent labels only" : "Saved labels"}
					</span>
				</div>
				{state.history.length ? (
					<div className="history-list">
						{state.history.map((result) => {
							const track = state.tracks[result.trackId];
							return (
								<article className="history-row" key={result.labelId}>
									{track ? (
										<Cover track={track} />
									) : (
										<span className="missing-cover">
											<Icon name="music" />
										</span>
									)}
									<div className="history-song">
										<h3>{track?.title ?? "Saved preference"}</h3>
										<p>
											{track?.artists.map((artist) => artist.name).join(", ") ??
												result.trackId}
										</p>
										<a
											className="text-link"
											target="_blank"
											rel="noreferrer"
											href={`https://open.spotify.com/track/${result.trackId}`}
										>
											Open in Spotify
										</a>
									</div>
									<span className="decision-tag">
										Would {result.submittedLabel === 0 ? "keep" : "remove"} ·{" "}
										{result.state}
									</span>
									<button
										type="button"
										className="button ghost small"
										disabled={
											locked || !result.canUndo || result.state !== "active"
										}
										onClick={() => onUndo(result.labelId)}
									>
										Undo label
									</button>
								</article>
							);
						})}
					</div>
				) : (
					<p className="fine-print">
						Your confirmed preference labels will appear here.
					</p>
				)}
				<p className="fine-print">
					Undo revokes a label for future fits. Superseded labels are no longer
					active. Cleanup decisions have their own separate history.
				</p>
			</section>
		</div>
	);
}
function CalibrationCard({
	item,
	busy,
	onAction,
}: {
	item: CalibrationState["queue"][number];
	busy: boolean;
	onAction: (action: CalibrationAction) => void;
}) {
	const ref = useRef<HTMLElement>(null);
	const drag = useRef<{
		id: number;
		x: number;
		y: number;
		dx: number;
		dy: number;
	} | null>(null);
	const [cue, setCue] = useState<CalibrationAction | null>(null);
	function start(event: PointerEvent<HTMLElement>) {
		if (busy || event.button !== 0) return;
		drag.current = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			dx: 0,
			dy: 0,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	}
	function move(event: PointerEvent<HTMLElement>) {
		const point = drag.current;
		if (!point || point.id !== event.pointerId) return;
		point.dx = event.clientX - point.x;
		point.dy = event.clientY - point.y;
		if (ref.current)
			ref.current.style.transform = `translate(${point.dx}px,${point.dy}px) rotate(${point.dx / 25}deg)`;
		setCue(calibrationActionFromDrag(point.dx, point.dy));
	}
	function end(event: PointerEvent<HTMLElement>, cancelled = false) {
		const point = drag.current;
		if (!point || point.id !== event.pointerId) return;
		drag.current = null;
		setCue(null);
		if (ref.current) ref.current.style.transform = "";
		if (!busy && !cancelled) {
			const action = calibrationActionFromDrag(point.dx, point.dy);
			if (action !== null) onAction(action);
		}
	}
	return (
		<div className="card-stage">
			<article
				className="song-card calibration-card"
				ref={ref}
				aria-label={`${item.track.title} by ${item.track.artists.map((artist) => artist.name).join(", ")}`}
				aria-busy={busy}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={(event) => end(event)}
				onPointerCancel={(event) => end(event, true)}
			>
				<Cover track={item.track} typography className="main-art" />
				{cue !== null && (
					<div
						className={`swipe-cue ${cue === 0 ? "keep" : cue === 1 ? "unlike" : "skip"}`}
					>
						<strong>
							{cue === 0 ? "Would keep" : cue === 1 ? "Would remove" : "Skip"}
						</strong>
						<small>Spotify stays unchanged</small>
					</div>
				)}
				<div className="song-details">
					<div className="song-title-line">
						<h2>{item.track.title}</h2>
						<span className="duration">{duration(item.track.durationMs)}</span>
					</div>
					<p>
						{item.track.artists.map((artist) => artist.name).join(", ")} ·{" "}
						{item.track.album}
					</p>
					<div className="saved-line">
						<span>
							Saved{" "}
							<time dateTime={item.track.originalAddedAt}>
								{savedDate(item.track.originalAddedAt)}
							</time>
						</span>
						<span>
							{item.track.releaseDate?.slice(0, 4) ?? "Release unknown"}
						</span>
					</div>
				</div>
			</article>
		</div>
	);
}
