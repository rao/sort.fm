import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReviewAction } from "@sortfm/contracts";
import type { ReviewClient } from "./data/demo-client";
import { ReviewStore, actionFromKey } from "./state/review";
import {
	Cover,
	EmptyState,
	Icon,
	Logo,
	Modal,
	Progress,
} from "./components/ui";
import { Landing } from "./components/Landing";
import { Library } from "./components/Library";
import { History } from "./components/History";
import { Insights } from "./components/Insights";
import { Dashboard } from "./components/Dashboard";
import { ModelPanel } from "./components/ModelPanel";
import { ActionButtons, SwipeCard } from "./components/SwipeCard";
const routes = [
	"library",
	"calibrate",
	"review",
	"history",
	"insights",
	"dashboard",
] as const;
type Route = "landing" | (typeof routes)[number];
function currentRoute(): Route {
	const path = window.location.hash.slice(2);
	return routes.includes(path as (typeof routes)[number])
		? (path as Route)
		: "landing";
}

export default function App({ client }: { client: ReviewClient }) {
	const [store] = useState(() => new ReviewStore(client, 240));
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	const [route, setRoute] = useState<Route>(currentRoute);
	const [modal, setModal] = useState<
		"connect" | "shortcuts" | "playback" | null
	>(null);
	const [toastDismissed, setToastDismissed] = useState(-1);
	const isReview = route === "review" || route === "calibrate";
	const current = state.queue[0];
	const completed = state.history.filter(
		({ result }) => result.status === "COMPLETE",
	);
	const labeled = completed.filter(
		({ result }) => result.labelState === "active",
	).length;
	const total = state.bootstrap?.queue.items.length ?? 0;
	const latest = state.history.find(({ result }) => result.canUndo);
	useEffect(() => {
		function navigate() {
			if (!window.location.hash.startsWith("#/")) return;
			setRoute(currentRoute());
			window.scrollTo(0, 0);
		}
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	useEffect(() => {
		if (route !== "landing") void store.load();
	}, [route, store]);
	useEffect(() => {
		document.title = `${route === "landing" ? "Make room for what moves you" : route === "calibrate" ? "Taste calibration" : route[0]!.toUpperCase() + route.slice(1)} · sort.fm`;
	}, [route]);
	useEffect(() => {
		function keydown(event: KeyboardEvent) {
			const target = event.target as HTMLElement | null;
			if (
				!isReview ||
				modal ||
				event.repeat ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(event.shiftKey && event.key !== "?") ||
				target?.closest(
					"input,textarea,select,button,a,summary,dialog,[contenteditable=true]",
				)
			)
				return;
			const action = actionFromKey(event.key);
			if (event.key === "?") {
				event.preventDefault();
				setModal("shortcuts");
			} else if (action) {
				event.preventDefault();
				void store.decide(action);
			} else if (event.key.toLowerCase() === "z" && latest) {
				event.preventDefault();
				void store.undo(latest.result.decisionId);
			}
		}
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [isReview, modal, store, latest]);
	const decide = (action: ReviewAction) => {
		void store.decide(action);
	};
	const dialog = modal && (
		<Modal
			title={
				modal === "connect"
					? "Your library. Your next chapter."
					: modal === "shortcuts"
						? "Less clicking. More feeling."
						: "A quiet demo, by design."
			}
			onClose={() => setModal(null)}
		>
			{modal === "connect" ? (
				<>
					<p>
						Spotify connection is for approved accounts during development. The
						live connection will be enabled by the integration team.
					</p>
					<div className="modal-callout">
						<Icon name="library" />
						<div>
							<strong>Everyone can try the demo</strong>
							<p>
								Fictional songs, original cover art, and the complete sorting
								experience. No Spotify changes.
							</p>
						</div>
					</div>
					<button
						type="button"
						className="button primary wide"
						onClick={() => {
							setModal(null);
							window.location.hash = "/library";
						}}
					>
						Try demo <Icon name="arrow" size={17} />
					</button>
				</>
			) : modal === "shortcuts" ? (
				<>
					<p>
						Use the arrow keys while you're in the review workspace, or drag the
						album in the same direction.
					</p>
					<div className="shortcut-list">
						{[
							["→", "Keep", "Still love it. Stays in Liked Songs."],
							["←", "Archive", "Save to a private archive, then unlike."],
							["↑", "Skip", "Not sure? Leave it unlabeled."],
							["↓", "Unlike", "Remove directly, without an archive copy."],
							["Z", "Undo", "Bring your last decision back."],
						].map(([key, title, description]) => (
							<div key={key}>
								<kbd>{key}</kbd>
								<div>
									<strong>{title}</strong>
									<p>{description}</p>
								</div>
							</div>
						))}
					</div>
					<p className="fine-print">
						All decisions are simulated in demo mode. Shortcuts pause while
						dialogs or interactive controls have focus.
					</p>
				</>
			) : (
				<>
					<p>
						These artists and songs are fictional, so there's no recording to
						play. You can still explore every sorting interaction.
					</p>
					<p>
						Connected tracks will offer an Open in Spotify link. In-browser
						playback belongs to the upcoming playback integration.
					</p>
					<button
						type="button"
						className="button primary wide"
						onClick={() => setModal(null)}
					>
						Back to the music
					</button>
				</>
			)}
		</Modal>
	);
	if (route === "landing")
		return (
			<>
				<Landing onConnect={() => setModal("connect")} />
				{dialog}
			</>
		);
	return (
		<div className="app-shell">
			<button
				type="button"
				className="skip-link"
				onClick={() => document.getElementById("main")?.focus()}
			>
				Skip to content
			</button>
			<header className="app-header">
				<Logo />
				<nav aria-label="Workspace navigation">
					{[
						["review", "Sort music", "music"],
						["dashboard", "Your library", "library"],
						["history", "History", "clock"],
					].map(([path, label, icon]) => (
						<a
							key={path}
							href={`#/${path}`}
							className={
								route === path || (path === "review" && route === "calibrate")
									? "active"
									: ""
							}
							aria-current={
								route === path || (path === "review" && route === "calibrate")
									? "page"
									: undefined
							}
						>
							<Icon name={icon as "music"} size={17} />
							{label}
						</a>
					))}
				</nav>
				<div className="header-right">
					<span className="demo-badge">
						<span /> DEMO MODE
					</span>
					<button
						type="button"
						className="avatar-button"
						onClick={() => setModal("connect")}
						aria-label="Account and Spotify connection"
					>
						D
					</button>
				</div>
			</header>
			<div className="demo-strip">
				<span>Good music. Zero commitment.</span> You're exploring a fictional
				library. Nothing changes on Spotify.
				<a href="#/insights">
					Model inspector <Icon name="arrow" size={13} />
				</a>
			</div>
			<main id="main" tabIndex={-1}>
				{route === "library" || !state.bootstrap ? (
					<Library state={state} onRetry={() => void store.load()} />
				) : route === "history" ? (
					<History state={state} onUndo={(id) => void store.undo(id)} />
				) : route === "insights" ? (
					<Insights state={state} />
				) : route === "dashboard" ? (
					<Dashboard state={state} />
				) : !current ? (
					state.history.length ? (
						<Dashboard state={state} complete />
					) : (
						<EmptyState title="You're all caught up">
							<p>No songs are available in this collection.</p>
							<a className="button primary" href="#/library">
								View library
							</a>
						</EmptyState>
					)
				) : (
					<div className="workspace">
						<div className="workspace-heading">
							<div>
								<span className="eyebrow">
									{route === "calibrate"
										? "LET'S GET TO KNOW YOUR TASTE"
										: "A LITTLE SPACE FOR THE MUSIC YOU LOVE"}
								</span>
								<h1>
									{route === "calibrate"
										? "Start with a feeling."
										: "Still your kind of music?"}
								</h1>
								<p>
									{route === "calibrate"
										? "A few songs. An honest instinct. There's no wrong answer."
										: "Keep what moves you. Make room for what’s next."}
								</p>
							</div>
							<div className="session-counter">
								<strong>
									{String(completed.length).padStart(2, "0")}
									<span> / {String(total).padStart(2, "0")}</span>
								</strong>
								<span>
									{route === "calibrate"
										? `${labeled} labeled · taste calibration`
										: "songs reconsidered"}
								</span>
								<Progress
									value={completed.length}
									max={total}
									label="Session progress"
								/>
							</div>
						</div>
						{route === "calibrate" && (
							<div className="calibration-banner">
								<span>
									<Icon name="spark" size={17} />
									<strong>A little variety goes a long way.</strong> Aim for
									10–30 honest decisions when your library allows.
								</span>
								<a href="#/review">
									Pause calibration <Icon name="arrow" size={15} />
								</a>
							</div>
						)}
						<div className="workspace-grid">
							<section className="review-column" aria-label="Review songs">
								<div className="queue-overline">
									<span>
										<i className="status-dot" />
										{route === "calibrate"
											? "TASTE CALIBRATION"
											: "YOUR DAILY REDISCOVERY"}
									</span>
									<span>
										{String(completed.length + 1).padStart(2, "0")} /{" "}
										{String(total).padStart(2, "0")}
									</span>
								</div>
								<SwipeCard
									key={current.track.trackId}
									item={current}
									next={state.queue[1]}
									busy={state.busy || !!state.retry}
									departure={state.departure}
									onAction={decide}
								/>
								<ActionButtons
									disabled={state.busy || !!state.retry}
									onAction={decide}
								/>
								<div className="review-helper">
									<span>
										{state.busy
											? "Saving your decision…"
											: "Drag the cover or use your arrow keys"}
									</span>
									<button
										type="button"
										className="text-button"
										onClick={() => setModal("shortcuts")}
									>
										Keyboard shortcuts <kbd>?</kbd>
									</button>
								</div>
								<p className="destructive-note">
									<Icon name="info" size={13} /> Unlike removes without
									archiving. Undo is always one step away.
								</p>
							</section>
							<div className="workspace-aside">
								<ModelPanel
									prediction={current.prediction}
									labeled={labeled}
									total={total}
									metrics={state.bootstrap.metrics}
								/>
								<section className="up-next">
									<div className="section-top">
										<h2>On the horizon</h2>
										<span>{state.queue.length - 1} next</span>
									</div>
									{state.queue.slice(1, 4).map(({ track }) => (
										<div className="next-track" key={track.trackId}>
											<Cover track={track} />
											<div>
												<h3>{track.title}</h3>
												<p>{track.artists[0]?.name}</p>
											</div>
											<Icon name="music" size={15} />
										</div>
									))}
									{state.queue.length === 1 && (
										<p className="fine-print">One last song. Make it count.</p>
									)}
								</section>
							</div>
						</div>
					</div>
				)}
			</main>
			{state.error && state.bootstrap && (
				<div className="error-toast" role="alert">
					<Icon name="info" />
					<div>
						<strong>
							{state.terminal
								? "Review paused for recovery"
								: "Your song is still in the queue"}
						</strong>
						<p>{state.error}</p>
						{state.terminal && (
							<p>
								This command cannot be retried. Its outcome has not been treated
								as success.
							</p>
						)}
					</div>
					{state.terminal ? (
						state.bootstrap.session.mode === "demo" ? (
							<button
								type="button"
								className="button secondary small"
								onClick={() => window.location.reload()}
							>
								Restart demo
							</button>
						) : (
							<a className="button secondary small" href="#/history">
								View history
							</a>
						)
					) : (
						<button
							type="button"
							className="button secondary small"
							disabled={state.busy}
							onClick={() => void store.retry()}
						>
							Retry
						</button>
					)}
				</div>
			)}
			{state.notice &&
				state.noticeRevision !== toastDismissed &&
				!state.error && (
					<output className="undo-toast">
						<span className="toast-check">
							<Icon name="check" size={16} />
						</span>
						<span>{state.notice}</span>
						{state.noticeUndoId && (
							<button
								type="button"
								className="text-button"
								disabled={state.busy}
								onClick={() => void store.undo(state.noticeUndoId!)}
							>
								<Icon name="undo" size={15} /> Undo
							</button>
						)}
						<button
							type="button"
							className="icon-button"
							aria-label="Dismiss notification"
							onClick={() => setToastDismissed(state.noticeRevision)}
						>
							<Icon name="close" size={15} />
						</button>
					</output>
				)}
			<footer className="player-bar">
				<div className="player-track">
					{current && <Cover track={current.track} />}
					<div>
						<strong>{current?.track.title ?? "A little more room."}</strong>
						<span>
							{current?.track.artists[0]?.name ??
								"Your next favorite is out there."}
						</span>
					</div>
				</div>
				<button
					type="button"
					className="player-status"
					onClick={() => setModal("playback")}
				>
					<Icon name="headphones" size={18} />
					<span>
						Preview unavailable <span>• Fictional demo track</span>
					</span>
					<Icon name="info" size={14} />
				</button>
				<div className="player-end">
					{current?.track.spotifyUri ? (
						<a
							className="text-link"
							href={`https://open.spotify.com/track/${current.track.trackId}`}
							target="_blank"
							rel="noreferrer"
						>
							Open in Spotify <Icon name="external" size={14} />
						</a>
					) : (
						<span>Made for the love of music.</span>
					)}
					<button
						type="button"
						className="icon-button"
						onClick={() => setModal("shortcuts")}
						aria-label="Keyboard shortcuts"
					>
						<span className="keyboard-symbol">⌘</span>
					</button>
				</div>
			</footer>
			{dialog}
		</div>
	);
}
