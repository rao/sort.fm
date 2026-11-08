import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PUBLIC_ROUTES, type ReviewAction } from "@sortfm/contracts";
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
import { CalibrationWorkspace } from "./components/Calibration";
import { CalibrationStore } from "./state/calibration";
import {
	calibrationJournal,
	createCalibrationClient,
} from "./data/calibration-client";
import { ConnectedLibrary } from "./components/Connected";
import { History } from "./components/History";
import { BrowserPlayback } from "./components/BrowserPlayback";
import { BrowserPlayerStore } from "./state/browser-player";
import { createBrowserPlaybackClient } from "./data/browser-playback-client";
import {
	createSpotifySdkPlayer,
	supportsBrowserVolume,
} from "./data/spotify-sdk";
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

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export default function App({
	client,
	onConnect,
	onLogout,
}: {
	client: ReviewClient;
	onConnect?: () => void;
	onLogout?: () => void;
}) {
	const live = !!client.live;
	const shellRef = useRef<HTMLDivElement>(null);
	const footerRef = useRef<HTMLElement>(null);
	const [store] = useState(() => new ReviewStore(client, 240));
	const [calibration] = useState(() =>
		client.live
			? new CalibrationStore(
					createCalibrationClient(
						client.live.api,
						client.live.session,
						calibrationJournal(
							{
								getItem: (key) => window.sessionStorage.getItem(key),
								setItem: (key, value) =>
									window.sessionStorage.setItem(key, value),
								removeItem: (key) => window.sessionStorage.removeItem(key),
							},
							client.live.session.user!.id,
						),
					),
				)
			: null,
	);
	const [playback] = useState(() => {
		if (!client.live) return null;
		const gateway = createBrowserPlaybackClient(
			client.live.api,
			client.live.session,
		);
		return {
			gateway,
			store: new BrowserPlayerStore(gateway, createSpotifySdkPlayer, {
				volumeSupported: supportsBrowserVolume(),
			}),
		};
	});
	const [playbackStopped, setPlaybackStopped] = useState(false);
	function signOut() {
		// Local audio and SDK callbacks stop before a slow or failed server logout.
		playback?.store.dispose();
		setPlaybackStopped(true);
		onLogout?.();
	}
	const calibrationState = useSyncExternalStore(
		calibration?.subscribe ?? emptySubscribe,
		calibration?.getSnapshot ?? emptySnapshot,
		calibration?.getSnapshot ?? emptySnapshot,
	);
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	const [route, setRoute] = useState<Route>(() =>
		live && currentRoute() === "landing" ? "library" : currentRoute(),
	);
	const [modal, setModal] = useState<
		"connect" | "shortcuts" | "playback" | null
	>(null);
	const [toastDismissed, setToastDismissed] = useState(-1);
	const canRemove = !live || !!client.live?.session.capabilities.spotifyWrite;
	const isReview = route === "review";
	const current = state.queue[0];
	const completed = state.history.filter(
		({ result }) => result.status === "COMPLETE",
	);
	const labeled = live
		? (state.bootstrap?.metrics?.labeledExamples ?? null)
		: completed.filter(({ result }) => result.labelState === "active").length;
	const total = state.bootstrap?.queue.items.length ?? 0;
	const latest = state.history.find(({ result }) => result.canUndo);
	useEffect(() => {
		function navigate() {
			if (!window.location.hash.startsWith("#/")) return;
			setRoute(currentRoute());
			setModal(null);
			window.scrollTo(0, 0);
		}
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	useEffect(() => {
		if (
			route !== "landing" &&
			route !== "calibrate" &&
			!(live && route === "library")
		)
			void store.load();
	}, [route, store, live]);
	useEffect(() => {
		if (
			!live ||
			!["insights", "dashboard", "history", "review"].includes(route)
		)
			return;
		void store.refresh();
		if (route === "review") return;
		const timer = setInterval(() => {
			if (!document.hidden) void store.refresh();
		}, 15000);
		return () => clearInterval(timer);
	}, [live, route, store]);
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
				if (!canRemove && (action === "ARCHIVE" || action === "UNLIKE"))
					setModal("connect");
				else void store.decide(action);
			} else if (event.key.toLowerCase() === "z" && latest) {
				event.preventDefault();
				void store.undo(latest.result.decisionId);
			}
		}
		window.addEventListener("keydown", keydown);
		return () => window.removeEventListener("keydown", keydown);
	}, [isReview, modal, store, latest, canRemove]);
	// Route changes can mount the shell after the landing page; height also changes on mobile and errors.
	// biome-ignore lint/correctness/useExhaustiveDependencies: route mounts/unmounts these refs.
	useEffect(() => {
		const shell = shellRef.current;
		const footer = footerRef.current;
		if (!shell || !footer || typeof ResizeObserver === "undefined") return;
		const updateHeight = () =>
			shell.style.setProperty(
				"--player-height",
				`${footer.getBoundingClientRect().height}px`,
			);
		updateHeight();
		const observer = new ResizeObserver(updateHeight);
		observer.observe(footer);
		return () => observer.disconnect();
	}, [route]);
	const decide = (action: ReviewAction) => {
		if (!canRemove && (action === "ARCHIVE" || action === "UNLIKE"))
			setModal("connect");
		else void store.decide(action);
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
						{live
							? `Connected as ${client.live?.session.user?.displayName}. Archive and Unlike change your Spotify library after confirmation.`
							: "You are exploring the isolated demo. Connect Spotify to import and review your own Liked Songs."}
					</p>
					{!live && (
						<a
							className="button primary wide"
							href={`${(import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "")}${PUBLIC_ROUTES.authStart.path}`}
						>
							Connect Spotify
						</a>
					)}
					{live && (
						<div className="account-actions">
							<button
								className="button secondary"
								type="button"
								onClick={onConnect}
							>
								Reconnect Spotify
							</button>
							<button className="button ghost" type="button" onClick={signOut}>
								Sign out
							</button>
							<a className="button secondary" href="#/library">
								Sync library
							</a>
						</div>
					)}
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
							window.location.assign("?mode=demo#/library");
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
						{live
							? "A playable Spotify track is not available for this card."
							: "These artists and songs are fictional, so there is no recording to play. You can still explore every sorting interaction."}
					</p>
					<p>
						Connected tracks always offer an Open in Spotify link. Playback
						controls appear when the server enables them.
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
		<div className="app-shell" ref={shellRef}>
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
						["calibrate", "Teach your taste", "spark"],
						["dashboard", "Your library", "library"],
						["history", "History", "clock"],
					].map(([path, label, icon]) => (
						<a
							key={path}
							href={`#/${path}`}
							className={route === path ? "active" : ""}
							aria-current={route === path ? "page" : undefined}
						>
							<Icon name={icon as "music"} size={17} />
							{label}
						</a>
					))}
				</nav>
				<div className="header-right">
					<span className="demo-badge">
						<span /> {live ? "SPOTIFY CONNECTED" : "DEMO MODE"}
					</span>
					<button
						type="button"
						className="avatar-button"
						onClick={() => setModal("connect")}
						aria-label="Account and Spotify connection"
					>
						{live ? client.live?.session.user?.displayName.slice(0, 1) : "D"}
					</button>
				</div>
			</header>
			<div className="demo-strip">
				{route === "calibrate" ? (
					<>
						<span>Calibration only.</span> Your Spotify library stays unchanged.
					</>
				) : live ? (
					<>
						<span>Your library. Your decisions.</span> Archive and Unlike change
						Spotify after confirmation.
					</>
				) : (
					<>
						<span>Good music. Zero commitment.</span> You're exploring a
						fictional library. Nothing changes on Spotify.
					</>
				)}
				<a href="#/insights">
					Model inspector <Icon name="arrow" size={13} />
				</a>
			</div>
			<main id="main" tabIndex={-1}>
				{route === "calibrate" ? (
					<CalibrationWorkspace store={calibration} />
				) : live && route === "library" ? (
					<ConnectedLibrary
						api={client.live!.api}
						onConnect={onConnect ?? (() => {})}
						onReview={() => {
							window.location.hash = "/review";
							setRoute("review");
						}}
					/>
				) : live && !state.bootstrap ? (
					<EmptyState
						title={
							state.loading
								? "Finding your next song"
								: "Your review workspace is waiting"
						}
					>
						<p role={state.error ? "alert" : "status"}>
							{state.error ?? "Loading your saved library and review queue…"}
						</p>
						{state.error && (
							<button
								type="button"
								className="button primary"
								onClick={() => void store.load()}
							>
								Retry workspace
							</button>
						)}
						<a className="button secondary" href="#/library">
							View import
						</a>
					</EmptyState>
				) : route === "library" || !state.bootstrap ? (
					<Library state={state} onRetry={() => void store.load()} />
				) : route === "history" ? (
					<History state={state} onUndo={(id) => void store.undo(id)} />
				) : route === "insights" ? (
					<Insights
						state={state}
						onRetrain={() => void store.retrain()}
						onRefresh={() => void store.refresh()}
					/>
				) : route === "dashboard" ? (
					<Dashboard state={state} />
				) : !current ? (
					live &&
					(state.remaining !== 0 ||
						!!state.refreshError ||
						state.refreshing) ? (
						<EmptyState title="Your queue is updating">
							<p>
								{state.refreshError ??
									`${state.remaining ?? "More"} songs remain on the server. Refresh to load the next selection.`}
							</p>
							<button
								type="button"
								className="button primary"
								disabled={state.refreshing}
								onClick={() => void store.refresh()}
							>
								Refresh queue
							</button>
						</EmptyState>
					) : state.history.length ? (
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
									A LITTLE SPACE FOR THE MUSIC YOU LOVE
								</span>
								<h1>Still your kind of music?</h1>
								<p>Keep what moves you. Make room for what’s next.</p>
							</div>
							<div className="session-counter">
								<strong>
									{live
										? state.remaining
										: String(completed.length).padStart(2, "0")}
									{!live && <span> / {String(total).padStart(2, "0")}</span>}
								</strong>
								<span>
									{live ? "songs left to review" : "songs reconsidered"}
								</span>
								{!live && (
									<Progress
										value={completed.length}
										max={total}
										label="Session progress"
									/>
								)}
							</div>
						</div>

						<div className="workspace-grid">
							<section className="review-column" aria-label="Review songs">
								<div className="queue-overline">
									<span>
										<i className="status-dot" />
										YOUR DAILY REDISCOVERY
									</span>
									<span>
										{live
											? `${state.queue.length} loaded`
											: `${String(completed.length + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`}
									</span>
								</div>
								<SwipeCard
									key={current.track.trackId}
									item={current}
									next={state.queue[1]}
									busy={
										state.busy ||
										state.retraining ||
										!!state.retry ||
										state.refreshing ||
										!!state.refreshError
									}
									departure={state.departure}
									onAction={decide}
								/>
								<ActionButtons
									canRemove={canRemove}
									disabled={
										state.busy ||
										state.retraining ||
										!!state.retry ||
										state.refreshing ||
										!!state.refreshError
									}
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
									<Icon name="info" size={13} />{" "}
									{canRemove
										? "Unlike removes without archiving. Undo is available after confirmation."
										: "Archive and Unlike are unavailable in this read-only session. Reconnect when library write access is enabled."}
								</p>
							</section>
							<div className="workspace-aside">
								<ModelPanel
									prediction={current.prediction}
									labeled={labeled}
									total={total}
									live={live}
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
			{route !== "calibrate" &&
				(state.warnings.length > 0 || state.refreshError) && (
					<output className="live-status-panel">
						<p>{state.refreshError ?? state.warnings.join(" · ")}</p>
						<button
							type="button"
							className="text-button"
							disabled={
								state.busy ||
								state.retraining ||
								state.refreshing ||
								!!state.retry
							}
							onClick={() => void store.refresh()}
						>
							Refresh server data
						</button>
					</output>
				)}
			{route !== "calibrate" && state.error && state.bootstrap && (
				<div className="error-toast" role="alert">
					<Icon name="info" />
					<div>
						<strong>
							{state.unavailable
								? "Action not available yet"
								: state.terminal
									? "Review paused for recovery"
									: "Your command needs attention"}
						</strong>
						<p>{state.error}</p>
						{state.terminal && (
							<p>
								Review is paused until account recovery or a settled server
								outcome. No successful mutation has been assumed.
							</p>
						)}
					</div>
					{live && state.retry && (
						<button
							type="button"
							className="button secondary small"
							disabled={state.busy || state.retraining || state.refreshing}
							onClick={() => void store.recover()}
						>
							Check saved outcome
						</button>
					)}
					{state.unavailable ? (
						<button
							type="button"
							className="button secondary small"
							onClick={() => store.dismissUnavailable()}
						>
							Dismiss
						</button>
					) : state.terminal ? (
						state.bootstrap.session.mode === "demo" ? (
							<button
								type="button"
								className="button secondary small"
								onClick={() => window.location.reload()}
							>
								Restart demo
							</button>
						) : (
							<button
								type="button"
								className="button secondary small"
								onClick={onConnect}
							>
								Reconnect Spotify
							</button>
						)
					) : (
						<button
							type="button"
							className="button secondary small"
							disabled={state.busy || state.retraining || state.refreshing}
							onClick={() => void store.retry()}
						>
							Retry
						</button>
					)}
				</div>
			)}
			{route !== "calibrate" &&
				state.notice &&
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
								disabled={state.busy || state.retraining || state.refreshing}
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
			{playback ? (
				<footer className="player-bar" ref={footerRef}>
					{playbackStopped ? (
						<output aria-live="polite">
							Playback stopped for sign-out. Retry sign out or reconnect Spotify
							to listen again.
						</output>
					) : (
						<BrowserPlayback
							store={playback.store}
							gateway={playback.gateway}
							track={
								route === "calibrate"
									? (calibrationState?.queue[0]?.track ?? null)
									: route === "review"
										? (current?.track ?? null)
										: null
							}
							returnTo={route === "calibrate" ? "calibration" : "review"}
						/>
					)}
				</footer>
			) : (
				route !== "calibrate" && (
					<footer className="player-bar" ref={footerRef}>
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
								Preview unavailable{" "}
								<span>
									•{" "}
									{live ? "Open this song in Spotify" : "Fictional demo track"}
								</span>
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
				)
			)}
			{dialog}
		</div>
	);
}
