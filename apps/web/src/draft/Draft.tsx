import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type CSSProperties,
} from "react";
import {
	AnimatePresence,
	motion,
	MotionConfig,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from "motion/react";
import {
	RiArrowRightLine,
	RiArrowLeftLine,
	RiArrowUpLine,
	RiArrowGoBackLine,
	RiArrowRightUpLine,
	RiHeartLine,
	RiArchiveLine,
	RiThumbDownLine,
	RiMusic2Line,
	RiFolderMusicLine,
	RiHistoryLine,
	RiEqualizerLine,
	RiBookOpenLine,
	RiSunLine,
	RiMoonLine,
	RiCloseLine,
	RiHeadphoneLine,
	RiCheckLine,
	RiPlayFill,
	RiVolumeMuteLine,
	RiVolumeUpLine,
} from "@remixicon/react";
import { Button, ButtonLink } from "#ui/components/base/buttons/button";
import { SearchField } from "#ui/components/base/search-field/search-field";
import { demoTracks } from "@sortfm/contracts/fixtures";
import type { ReviewAction, TrackCard } from "@sortfm/contracts";
import { createDemoClient } from "../data/demo-client";
import {
	ReviewStore,
	actionFromDrag,
	actionFromKey,
	actionPast,
} from "../state/review";
import { ModelLab } from "../components/ModelLab";
import { cx } from "#ui/utils/cx";

const screens = [
	"home",
	"review",
	"calibrate",
	"dashboard",
	"history",
	"insights",
	"library",
] as const;
type Screen = (typeof screens)[number];
const nav = [
	{ id: "review", label: "Sort", icon: RiMusic2Line },
	{ id: "calibrate", label: "Teach", icon: RiHeartLine },
	{ id: "dashboard", label: "Library", icon: RiFolderMusicLine },
	{ id: "history", label: "History", icon: RiHistoryLine },
	{ id: "insights", label: "Model", icon: RiEqualizerLine },
] as const;
const decisions = [
	{ action: "ARCHIVE", label: "Archive", icon: RiArchiveLine, key: "←" },
	{ action: "UNLIKE", label: "Unlike", icon: RiThumbDownLine, key: "↓" },
	{ action: "SKIP", label: "Skip", icon: RiArrowUpLine, key: "↑" },
	{ action: "KEEP", label: "Keep", icon: RiHeartLine, key: "→" },
] as const;
const artist = (track: TrackCard) =>
	track.artists.map((a) => a.name).join(", ");
const date = (track: TrackCard) =>
	new Date(track.originalAddedAt).toLocaleDateString("en-US", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	});
const duration = (track: TrackCard) =>
	`${Math.floor(track.durationMs / 60000)}:${String(Math.floor(track.durationMs / 1000) % 60).padStart(2, "0")}`;
function readScreen(): Screen {
	const hash = window.location.hash.replace("#/", "");
	return screens.includes(hash as Screen) ? (hash as Screen) : "home";
}
function Mark() {
	return (
		<a className="draft-logo" href="#/home" aria-label="sort.fm home">
			<span aria-hidden="true">
				<i />
				<i />
				<i />
				<i />
			</span>
			sort.fm
		</a>
	);
}
function Art({
	track,
	className,
	title = true,
}: {
	track: TrackCard;
	className?: string;
	title?: boolean;
}) {
	const index = (Number(track.trackId.split(":")[1]) - 1) % 4;
	return (
		<div
			className={cx("d-art", className)}
			style={
				{
					"--art-x": index % 2 ? "100%" : "0%",
					"--art-y": index > 1 ? "100%" : "0%",
				} as CSSProperties
			}
			role="img"
			aria-label={`Fictional cover for ${track.album}`}
		>
			{title && (
				<div className="d-art-type">
					<span>{artist(track)}</span>
					<strong>{track.album}</strong>
					<small>{track.releaseDate} · DEMO EDITION</small>
				</div>
			)}
		</div>
	);
}
function PageHeading({
	eyebrow,
	title,
	children,
}: {
	eyebrow: string;
	title: string;
	children?: React.ReactNode;
}) {
	return (
		<header className="d-page-heading">
			<p className="d-kicker">{eyebrow}</p>
			<h1>{title}</h1>
			{children}
		</header>
	);
}
function SwipeSleeve({
	track,
	busy,
	onAction,
}: {
	track: TrackCard;
	busy: boolean;
	onAction: (a: ReviewAction) => void;
}) {
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const rotate = useTransform(x, [-220, 220], [-13, 13]);
	const keepOpacity = useTransform(x, [35, 100], [0, 1]);
	const archiveOpacity = useTransform(x, [-100, -35], [1, 0]);
	const reduced = useReducedMotion();
	return (
		<motion.div
			className="d-sleeve"
			drag={!busy}
			dragSnapToOrigin
			dragElastic={0.8}
			style={{ x, y, rotate: reduced ? 0 : rotate }}
			whileDrag={{ cursor: "grabbing", scale: reduced ? 1 : 1.025 }}
			onDragEnd={(_, info) => {
				const action = actionFromDrag(info.offset.x, info.offset.y);
				if (action) onAction(action);
			}}
			aria-label={`${track.title} by ${artist(track)}`}
			aria-busy={busy}
		>
			<Art track={track} />
			<motion.span
				aria-hidden="true"
				className="d-drag-stamp keep"
				style={{ opacity: keepOpacity }}
			>
				KEEP
			</motion.span>
			<motion.span
				aria-hidden="true"
				className="d-drag-stamp archive"
				style={{ opacity: archiveOpacity }}
			>
				ARCHIVE
			</motion.span>
			<div className="d-sleeve-caption">
				<span>Saved {date(track)}</span>
				<span>{duration(track)}</span>
			</div>
		</motion.div>
	);
}

export function Draft() {
	const [store] = useState(
		() => new ReviewStore(createDemoClient({ latency: 120 }), 180),
	);
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	const [screen, setScreen] = useState<Screen>(readScreen);
	const [night, setNight] = useState(false);
	const [showPanels, setShowPanels] = useState(() => window.innerWidth >= 1100);
	const [showPlayback, setShowPlayback] = useState(
		() => window.innerWidth > 600,
	);
	const [sound, setSound] = useState(false);
	const audioRef = useRef<AudioContext | null>(null);
	const tick = useCallback(() => {
		if (!sound) return;
		audioRef.current ??= new AudioContext();
		const context = audioRef.current;
		void context.resume();
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		oscillator.type = "sine";
		oscillator.frequency.setValueAtTime(620, context.currentTime);
		oscillator.frequency.exponentialRampToValueAtTime(
			240,
			context.currentTime + 0.045,
		);
		gain.gain.setValueAtTime(0.035, context.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.06);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start();
		oscillator.stop(context.currentTime + 0.065);
	}, [sound]);
	useEffect(
		() => () => {
			void audioRef.current?.close();
		},
		[],
	);
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState("ALL");
	const [dialog, setDialog] = useState<
		"shortcuts" | "audio" | "account" | null
	>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const [transitioning, setTransitioning] = useState(false);
	const [direction, setDirection] = useState<ReviewAction>("KEEP");
	const [practiceIndex, setPracticeIndex] = useState(0);
	const [practiceNotice, setPracticeNotice] = useState("");
	const reduced = useReducedMotion();
	const current = state.queue[0]?.track;
	const completed = state.history.filter((e) => e.result.status === "COMPLETE");
	const latest = state.history.find((e) => e.result.canUndo);
	const count = (action: ReviewAction) =>
		completed.filter((e) => e.result.action === action).length;
	const go = (next: Screen) => {
		window.location.hash = `/${next}`;
	};
	const act = useCallback(
		(action: ReviewAction) => {
			if (state.busy || transitioning || !current) return;
			setTransitioning(true);
			setDirection(action);
			tick();
			void store.decide(action).finally(() => {
				if (store.getSnapshot().queue[0]?.track.trackId === current.trackId)
					setTransitioning(false);
			});
		},
		[state.busy, transitioning, current, tick, store],
	);
	useEffect(() => {
		void store.load();
	}, [store]);
	useEffect(() => {
		const change = () => {
			setScreen(readScreen());
			setSearch("");
			setFilter("ALL");
			window.scrollTo({ top: 0, behavior: "instant" });
		};
		window.addEventListener("hashchange", change);
		return () => window.removeEventListener("hashchange", change);
	}, []);
	useEffect(() => {
		document.documentElement.classList.toggle("dark", night);
	}, [night]);
	useEffect(() => {
		document.title = `${screen === "home" ? "Pocket player" : (nav.find((n) => n.id === screen)?.label ?? "Import library")} · sort.fm draft`;
	}, [screen]);
	useEffect(() => {
		if (dialog) dialogRef.current?.showModal();
		else dialogRef.current?.close();
	}, [dialog]);
	useEffect(() => {
		const handle = (e: KeyboardEvent) => {
			if (
				screen !== "review" ||
				dialog ||
				e.repeat ||
				e.metaKey ||
				e.ctrlKey ||
				e.altKey ||
				(e.target as HTMLElement)?.closest(
					"button,a,input,textarea,select,dialog",
				)
			)
				return;
			const action = actionFromKey(e.key);
			if (action) {
				e.preventDefault();
				act(action);
			} else if (e.key.toLowerCase() === "z" && latest) {
				e.preventDefault();
				void store.undo(latest.result.decisionId);
			} else if (e.key === "?") setDialog("shortcuts");
		};
		window.addEventListener("keydown", handle);
		return () => window.removeEventListener("keydown", handle);
	}, [screen, dialog, latest, act, store]);
	const exit =
		direction === "KEEP"
			? { x: 190, rotate: 12 }
			: direction === "ARCHIVE"
				? { x: -190, rotate: -12 }
				: { y: direction === "SKIP" ? -160 : 160 };
	const visibleHistory = state.history.filter(
		(e) =>
			(filter === "ALL" || e.result.action === filter) &&
			`${e.item?.track.title} ${e.item ? artist(e.item.track) : ""}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	const visibleTracks = demoTracks.filter((t) =>
		`${t.title} ${artist(t)} ${t.album}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);

	return (
		<MotionConfig reducedMotion="user">
			<div className={cx("draft-root", !showPlayback && "playback-hidden")}>
				<button
					type="button"
					className="d-skip"
					onClick={(e) => {
						e.preventDefault();
						document.getElementById("draft-main")?.focus();
					}}
				>
					Skip to content
				</button>
				<div className="d-draft-strip">
					<span>
						<i /> sort.fm music desk · draft 03
					</span>
					<span>Fictional library. No Spotify changes.</span>
				</div>
				{screen === "home" ? (
					<>
						<header className="d-home-nav">
							<Mark />
							<div>
								<Button
									variant="secondary"
									iconOnly
									leadingIcon={night ? RiSunLine : RiMoonLine}
									aria-label={
										night ? "Switch to day mode" : "Switch to night mode"
									}
									onClick={() => setNight(!night)}
								/>
								<Button variant="secondary" onClick={() => go("review")}>
									Open demo <RiArrowRightUpLine size={17} />
								</Button>
							</div>
						</header>
						<main id="draft-main" tabIndex={-1} className="d-home">
							<section className="d-home-hero">
								<div className="d-home-copy">
									<p className="d-kicker">
										A LITTLE DESKTOP FOR YOUR BIG MUSIC FEELINGS
									</p>
									<h1>
										Old favorites.
										<br />
										<span>New feelings.</span>
									</h1>
									<p>
										Your Liked Songs, reloaded. A little player for
										rediscovering what still hits—and making room for what’s
										next.
									</p>
									<Button
										onClick={() => go("review")}
										trailingIcon={RiArrowRightLine}
									>
										Power it on
									</Button>
									<span className="d-home-caption">
										Try the demo. Bring your Spotify library later.
									</span>
								</div>
								<motion.div
									className="d-hero-device"
									initial={{
										opacity: 0,
										y: reduced ? 0 : 35,
										rotate: reduced ? 0 : 5,
									}}
									animate={{ opacity: 1, y: 0, rotate: reduced ? 0 : -5 }}
									transition={{ type: "spring", stiffness: 110, damping: 18 }}
									whileHover={{ rotate: 0, y: reduced ? 0 : -6 }}
								>
									<div className="d-hardware-label">
										<strong>sort.fm</strong>
										<span>PERSONAL MUSIC SORTER · 01</span>
										<i />
									</div>
									<div className="d-hero-screen">
										<div className="d-lcd-status">
											<span>READY TO REDISCOVER</span>
											<span>DEMO ▰</span>
										</div>
										<Art track={demoTracks[0]!} />
										<strong>{demoTracks[0]!.title}</strong>
										<span>
											{artist(demoTracks[0]!)} / {demoTracks[0]!.album}
										</span>
										<div className="d-lcd-bars" aria-hidden="true">
											{Array.from({ length: 23 }, (_, i) => (
												<i
													key={i}
													style={{ height: `${8 + ((i * 13) % 25)}px` }}
												/>
											))}
										</div>
									</div>
									<div className="d-hero-wheel">
										<span>SKIP</span>
										<RiArrowLeftLine />
										<Button
											iconOnly
											leadingIcon={RiPlayFill}
											aria-label="Power on the demo player"
											onClick={() => go("review")}
										/>
										<RiArrowRightLine />
										<small>YOUR MUSIC. YOUR CALL.</small>
									</div>
									<div className="d-device-bottom">
										<span>DESIGNED FOR CHANGING TASTE</span>
										<div className="d-speaker" aria-hidden="true" />
									</div>
								</motion.div>
							</section>
							<section className="d-home-bottom">
								<div>
									<span className="d-number">01</span>
									<h2>
										A little less scrolling.
										<br />A lot more listening.
									</h2>
								</div>
								<p>
									One song at a time. Keep it, archive it, or come back later.
									Your choices help the model learn your taste; you make the
									final call.
								</p>
								<Button
									variant="secondary"
									onClick={() => go("insights")}
									trailingIcon={RiArrowRightUpLine}
								>
									How it learns
								</Button>
							</section>
							<section className="d-home-flow">
								{[
									{
										n: "01",
										title: "Bring the collection",
										body: "Import your saved songs, keeping the artist, album, and original saved date together.",
									},
									{
										n: "02",
										title: "Go with your ears",
										body: "Swipe or use the arrow keys. Archive saves a copy before removing the like. Undo is close by.",
									},
									{
										n: "03",
										title: "Make it personal",
										body: "Teach your taste without changing Spotify. See the model’s progress and limitations in the inspector.",
									},
								].map((s) => (
									<article key={s.n}>
										<span>{s.n}</span>
										<h3>{s.title}</h3>
										<p>{s.body}</p>
									</article>
								))}
							</section>
						</main>
						<footer className="d-home-footer">
							<Mark />
							<span>Same you. Different soundtrack.</span>
							<Button variant="secondary" onClick={() => go("library")}>
								Bring your library
							</Button>
						</footer>
					</>
				) : (
					<div className="d-shell">
						<aside className="d-sidebar">
							<Mark />
							<span className="d-nav-caption">PICK A CHANNEL</span>
							<nav aria-label="Workspace navigation">
								{nav.map((n) => (
									<a
										key={n.id}
										href={`#/${n.id}`}
										className={cx(screen === n.id && "is-current")}
										aria-current={screen === n.id ? "page" : undefined}
									>
										<span className="d-nav-glyph">
											<n.icon size={21} />
										</span>
										<span>{n.label}</span>
										{screen === n.id && <motion.i layoutId="nav-dot" />}
									</a>
								))}
							</nav>
							<div className="d-sidebar-bottom">
								<div className="d-collection-mini">
									<div className="d-mini-covers">
										{demoTracks.slice(0, 3).map((t) => (
											<Art key={t.trackId} track={t} title={false} />
										))}
									</div>
									<strong>Your demo collection</strong>
									<span>{demoTracks.length} songs to try things out.</span>
									<a href="#/library">
										Bring your own <RiArrowRightLine size={15} />
									</a>
								</div>
								<button
									type="button"
									className="d-profile"
									onClick={() => setDialog("account")}
								>
									<span>D</span>
									<div>
										<strong>Demo listener</strong>
										<small>Just exploring</small>
									</div>
									<RiArrowRightUpLine size={17} />
								</button>
							</div>
						</aside>
						<div className="d-content">
							<header className="d-topbar">
								<span>
									MUSIC DESK <span>▸</span>{" "}
									<strong>
										{nav.find((n) => n.id === screen)?.label ??
											"Import library"}
									</strong>
								</span>
								<div>
									<span className="d-demo-label">
										<i /> DEMO TAPE
									</span>
									<Button
										variant="secondary"
										iconOnly
										leadingIcon={sound ? RiVolumeUpLine : RiVolumeMuteLine}
										aria-label={
											sound
												? "Turn interface sounds off"
												: "Turn interface sounds on"
										}
										aria-pressed={sound}
										onClick={() => setSound(!sound)}
									/>
									<Button
										variant="secondary"
										iconOnly
										leadingIcon={RiHeadphoneLine}
										aria-label={
											showPlayback ? "Hide playback dock" : "Show playback dock"
										}
										aria-pressed={showPlayback}
										onClick={() => setShowPlayback(!showPlayback)}
									/>
									<Button
										variant="secondary"
										iconOnly
										leadingIcon={night ? RiSunLine : RiMoonLine}
										aria-label={
											night ? "Switch to day mode" : "Switch to night mode"
										}
										onClick={() => setNight(!night)}
									/>
								</div>
							</header>
							<main id="draft-main" tabIndex={-1}>
								<AnimatePresence mode="wait">
									<motion.div
										key={screen}
										initial={{ opacity: 0, y: reduced ? 0 : 8 }}
										animate={{ opacity: 1, y: 0 }}
										exit={{ opacity: 0, y: reduced ? 0 : -5 }}
										transition={{ duration: 0.16 }}
									>
										{screen === "review" && (
											<div className="d-review-page">
												<div className="d-review-heading">
													<PageHeading
														eyebrow="Now sorting"
														title="Does it still hit?"
													>
														<p>Give it a moment. Go with your gut.</p>
													</PageHeading>
													<div className="d-session">
														<strong>
															{String(completed.length).padStart(2, "0")}
															<span> / {demoTracks.length}</span>
														</strong>
														<span>songs reconsidered</span>
														<div
															className="d-segments"
															role="img"
															aria-label={`${completed.length} of ${demoTracks.length} reviewed`}
														>
															{demoTracks.map((t, i) => (
																<i
																	key={t.trackId}
																	className={
																		i < completed.length ? "filled" : ""
																	}
																/>
															))}
														</div>
														{completed.length >= 3 && (
															<motion.div
																className="d-milestone"
																key={Math.floor(completed.length / 3)}
																initial={{
																	opacity: 0,
																	scale: reduced ? 1 : 0.8,
																	rotate: reduced ? 0 : -8,
																}}
																animate={{ opacity: 1, scale: 1, rotate: 0 }}
																transition={{
																	type: "spring",
																	stiffness: 300,
																	damping: 17,
																}}
															>
																<RiHeadphoneLine size={17} />
																<span>
																	{completed.length >= 12
																		? "Full pass complete"
																		: completed.length >= 6
																			? "Finding your frequency"
																			: "First listen complete"}
																</span>
															</motion.div>
														)}
													</div>
													<div className="d-desk-sticker" aria-hidden="true">
														<RiHeadphoneLine size={30} />
														<span>
															GOOD EARS.
															<br />
															NO PRESSURE.
														</span>
													</div>
												</div>
												{current ? (
													<div
														className={cx(
															"d-review-grid",
															!showPanels && "focus-mode",
														)}
													>
														<section
															className="d-song-stage"
															aria-label="Review songs"
														>
															<div className="d-hardware-label">
																<strong>sort.fm</strong>
																<span>PERSONAL MUSIC SORTER · 01</span>
																<i />
															</div>
															<div className="d-player-screen">
																<div className="d-stage-top">
																	<span>
																		<i className="d-led" /> NOW SORTING
																	</span>
																	<span>
																		{String(
																			demoTracks.length -
																				state.queue.length +
																				1,
																		).padStart(2, "0")}{" "}
																		<span className="d-muted">
																			/ {demoTracks.length}
																		</span>
																	</span>
																</div>
																<div className="d-sleeve-stack">
																	<div className="d-empty-sleeve" />
																	<AnimatePresence
																		mode="wait"
																		custom={direction}
																	>
																		<motion.div
																			key={current.trackId}
																			onAnimationComplete={() =>
																				setTransitioning(false)
																			}
																			initial={{
																				opacity: 0,
																				scale: reduced ? 1 : 0.96,
																				y: reduced ? 0 : 18,
																			}}
																			animate={{ opacity: 1, scale: 1, y: 0 }}
																			exit={
																				reduced
																					? { opacity: 0 }
																					: { ...exit, opacity: 0 }
																			}
																			transition={{ duration: 0.18 }}
																		>
																			<SwipeSleeve
																				track={current}
																				busy={state.busy || transitioning}
																				onAction={act}
																			/>
																		</motion.div>
																	</AnimatePresence>
																</div>
																<div className="d-track-heading">
																	<h2>{current.title}</h2>
																	<p>
																		{artist(current)} <span>·</span>{" "}
																		{current.album}
																	</p>
																</div>
															</div>
															<div className="d-device-controls">
																<div className="d-device-side">
																	<Button
																		variant="secondary"
																		iconOnly
																		leadingIcon={RiArrowGoBackLine}
																		className="d-undo"
																		aria-label="Undo latest decision"
																		disabled={!latest || state.busy}
																		onClick={() =>
																			latest &&
																			void store.undo(latest.result.decisionId)
																		}
																	/>
																	<span>UNDO</span>
																</div>
																<fieldset
																	className="d-decision-bar"
																	aria-label="Song decisions"
																>
																	{decisions.map((d) => (
																		<Button
																			key={d.action}
																			variant={
																				d.action === "KEEP"
																					? "primary"
																					: "secondary"
																			}
																			leadingIcon={d.icon}
																			className={cx(
																				"d-decision",
																				`wheel-${d.action.toLowerCase()}`,
																			)}
																			disabled={state.busy || transitioning}
																			onClick={() => act(d.action)}
																			aria-label={`${d.label} song (${d.key})`}
																		>
																			{d.label}
																			<kbd>{d.key}</kbd>
																		</Button>
																	))}
																	<Button
																		className="d-wheel-center"
																		variant="secondary"
																		iconOnly
																		leadingIcon={RiPlayFill}
																		aria-label="About audio preview"
																		onClick={() => setDialog("audio")}
																	/>
																</fieldset>
																<div className="d-device-side">
																	<Button
																		variant="secondary"
																		iconOnly
																		leadingIcon={RiEqualizerLine}
																		aria-label={
																			showPanels
																				? "Hide model and context panels"
																				: "Show model and context panels"
																		}
																		aria-pressed={showPanels}
																		onClick={() => setShowPanels(!showPanels)}
																	/>
																	<span>DETAILS</span>
																</div>
															</div>
															<div className="d-device-bottom">
																<span>
																	{completed.length >= 12
																		? "FULL PASS COMPLETE"
																		: completed.length >= 6
																			? "FINDING YOUR FREQUENCY"
																			: completed.length >= 3
																				? "FIRST LISTEN COMPLETE"
																				: "MAKE YOUR FIRST MOVES"}
																</span>
																<div className="d-speaker" aria-hidden="true" />
															</div>
															<div className="d-card-help">
																<span>
																	{state.busy
																		? "Saving your choice…"
																		: "Drag the sleeve. Follow your instinct."}
																</span>
																<button
																	type="button"
																	onClick={() => setDialog("shortcuts")}
																	aria-label="Keyboard shortcuts"
																>
																	⌨ Shortcuts
																</button>
															</div>
															<p className="d-risk-note">
																Archive keeps a playlist copy before unliking.
																Unlike removes directly.
															</p>
														</section>
														{showPanels && (
															<motion.aside
																className="d-review-notes"
																initial={{ opacity: 0, x: reduced ? 0 : 15 }}
																animate={{ opacity: 1, x: 0 }}
																transition={{ duration: 0.18 }}
															>
																<section className="d-note">
																	<span className="d-kicker">
																		A little context
																	</span>
																	<h3>
																		From your
																		<br />
																		{new Date(
																			current.originalAddedAt,
																		).getUTCFullYear()}{" "}
																		collection.
																	</h3>
																	<dl>
																		<div>
																			<dt>Saved</dt>
																			<dd>{date(current)}</dd>
																		</div>
																		<div>
																			<dt>Released</dt>
																			<dd>{current.releaseDate}</dd>
																		</div>
																		<div>
																			<dt>Length</dt>
																			<dd>{duration(current)}</dd>
																		</div>
																	</dl>
																	<p>
																		A date is a memory cue, not a reason to
																		remove a song.
																	</p>
																</section>
																<section className="d-model-note">
																	<RiEqualizerLine size={22} />
																	<h3>Your taste comes first.</h3>
																	<p>
																		This demo is unranked. A connected model can
																		suggest where to start; it never decides for
																		you.
																	</p>
																	<a href="#/insights">
																		Look under the hood{" "}
																		<RiArrowRightUpLine size={16} />
																	</a>
																</section>
																<section className="d-up-next">
																	<h3>
																		Coming up{" "}
																		<span>
																			{Math.max(0, state.queue.length - 1)}
																		</span>
																	</h3>
																	{state.queue.slice(1, 4).map(({ track }) => (
																		<div key={track.trackId}>
																			<Art track={track} title={false} />
																			<div>
																				<strong>{track.title}</strong>
																				<span>{artist(track)}</span>
																			</div>
																		</div>
																	))}
																</section>
															</motion.aside>
														)}
													</div>
												) : (
													<div className="d-empty">
														<RiCheckLine size={40} />
														<h2>
															{state.loading
																? "Opening your collection…"
																: "That’s the whole stack."}
														</h2>
														<p>
															{state.loading
																? "Getting the demo songs ready."
																: "Take a look at your choices. You can still change your mind."}
														</p>
														<Button onClick={() => go("history")}>
															View your history
														</Button>
													</div>
												)}
											</div>
										)}
										{screen === "dashboard" && (
											<div className="d-page">
												<PageHeading
													eyebrow="Your library"
													title="An evolving collection."
												>
													<p>
														All the songs you saved. Some old favorites, some
														happy accidents.
													</p>
												</PageHeading>
												<div className="d-library-summary">
													<div>
														<strong>{demoTracks.length}</strong>
														<span>demo songs</span>
													</div>
													<div>
														<strong>{count("KEEP")}</strong>
														<span>keepers so far</span>
													</div>
													<div>
														<strong>{state.queue.length}</strong>
														<span>still to reconsider</span>
													</div>
													<Button
														onClick={() => go("review")}
														trailingIcon={RiArrowRightLine}
													>
														Keep sorting
													</Button>
												</div>
												<div className="d-toolbar">
													<h2>
														The collection <span>{visibleTracks.length}</span>
													</h2>
													<SearchField
														aria-label="Search the collection"
														placeholder="Song, artist, or album"
														value={search}
														onChange={setSearch}
													/>
												</div>
												<div className="d-album-grid">
													{visibleTracks.map((t, i) => (
														<motion.article
															key={t.trackId}
															whileHover={
																reduced
																	? undefined
																	: { y: -5, rotate: i % 2 ? 1 : -1 }
															}
															initial={{ opacity: 0, y: reduced ? 0 : 12 }}
															animate={{ opacity: 1, y: 0 }}
															transition={{
																duration: 0.18,
																delay: Math.min(i * 0.025, 0.15),
															}}
														>
															<Art track={t} />
															<div>
																<h3>{t.title}</h3>
																<span>{artist(t)}</span>
																<small>Saved {date(t)}</small>
															</div>
														</motion.article>
													))}
												</div>
												{!visibleTracks.length && (
													<div className="d-empty">
														<h2>No matches in this collection.</h2>
														<Button
															variant="secondary"
															onClick={() => setSearch("")}
														>
															Clear search
														</Button>
													</div>
												)}
											</div>
										)}
										{screen === "history" && (
											<div className="d-page">
												<PageHeading
													eyebrow="History"
													title="Room to change your mind."
												>
													<p>
														Every choice stays here. Restore a song when you
														want it back.
													</p>
												</PageHeading>
												<div className="d-toolbar">
													<fieldset
														className="d-filter-tabs"
														aria-label="Filter decisions"
													>
														{["ALL", "KEEP", "ARCHIVE", "UNLIKE", "SKIP"].map(
															(f) => (
																<Button
																	key={f}
																	variant="secondary"
																	className={filter === f ? "selected" : ""}
																	aria-pressed={filter === f}
																	onClick={() => setFilter(f)}
																>
																	{f === "ALL"
																		? "All"
																		: actionPast[f as ReviewAction]}
																</Button>
															),
														)}
													</fieldset>
													<SearchField
														aria-label="Search decision history"
														placeholder="Find a song"
														value={search}
														onChange={setSearch}
													/>
												</div>
												<div className="d-history-list">
													{visibleHistory.map((e) => (
														<motion.article layout key={e.result.decisionId}>
															{e.item && (
																<Art track={e.item.track} title={false} />
															)}
															<div>
																<h3>{e.item?.track.title}</h3>
																<p>{e.item && artist(e.item.track)}</p>
															</div>
															<span className="d-status">
																{e.result.status === "UNDONE"
																	? "Restored"
																	: actionPast[e.result.action]}
															</span>
															<Button
																variant="secondary"
																leadingIcon={RiArrowGoBackLine}
																className="d-undo"
																disabled={!e.result.canUndo || state.busy}
																onClick={() =>
																	void store.undo(e.result.decisionId)
																}
															>
																{e.result.canUndo ? "Undo" : "Restored"}
															</Button>
														</motion.article>
													))}
												</div>
												{state.history.length > 0 &&
													visibleHistory.length === 0 && (
														<div className="d-empty">
															<h2>No choices match just yet.</h2>
															<Button
																variant="secondary"
																onClick={() => {
																	setSearch("");
																	setFilter("ALL");
																}}
															>
																Clear filters
															</Button>
														</div>
													)}
												{state.history.length === 0 && (
													<div className="d-empty">
														<RiHistoryLine size={40} />
														<h2>Your story starts with a song.</h2>
														<p>
															Make your first choice and it will appear here.
														</p>
														<Button onClick={() => go("review")}>
															Sort your first song
														</Button>
													</div>
												)}
											</div>
										)}
										{screen === "calibrate" && (
											<div className="d-page">
												<PageHeading
													eyebrow="Teach your taste"
													title="A little getting-to-know-you."
												>
													<p>
														Tell the model what you would keep. Your Spotify
														library stays as it is.
													</p>
												</PageHeading>
												<div className="d-calibration">
													<div>
														<span className="d-status">
															Interaction rehearsal · no labels saved
														</span>
														<AnimatePresence mode="wait">
															<motion.div
																key={practiceIndex}
																initial={{ opacity: 0, x: reduced ? 0 : 20 }}
																animate={{ opacity: 1, x: 0 }}
																exit={{ opacity: 0, x: reduced ? 0 : -20 }}
																transition={{ duration: 0.16 }}
															>
																<Art
																	track={
																		demoTracks[
																			practiceIndex % demoTracks.length
																		]!
																	}
																/>
																<h2>
																	{
																		demoTracks[
																			practiceIndex % demoTracks.length
																		]!.title
																	}
																</h2>
																<p>
																	{artist(
																		demoTracks[
																			practiceIndex % demoTracks.length
																		]!,
																	)}
																</p>
															</motion.div>
														</AnimatePresence>
														<div className="d-practice-actions">
															<Button
																variant="secondary"
																onClick={() => {
																	setPracticeIndex((i) => i + 1);
																	setPracticeNotice(
																		"Remove preference previewed. Nothing saved.",
																	);
																}}
															>
																Would remove
															</Button>
															<Button
																onClick={() => {
																	setPracticeIndex((i) => i + 1);
																	setPracticeNotice(
																		"Keep preference previewed. Nothing saved.",
																	);
																}}
																leadingIcon={RiHeartLine}
															>
																Would keep
															</Button>
														</div>
														<button
															type="button"
															className="d-text-button"
															onClick={() => {
																setPracticeIndex((i) => i + 1);
																setPracticeNotice("Skipped in the rehearsal.");
															}}
														>
															Not sure? Skip this one
														</button>
														<output className="d-muted" aria-live="polite">
															{practiceNotice}
														</output>
													</div>
													<aside>
														<RiBookOpenLine size={32} />
														<h2>
															Teach first.
															<br />
															Sort when you’re ready.
														</h2>
														<p>
															Calibration is separate from cleaning up your
															library. It records preferences without archiving
															or unliking anything.
														</p>
														<ul>
															<li>Your answers become feedback.</li>
															<li>Predictions stay hidden while you label.</li>
															<li>
																Evaluation examples stay separate from training.
															</li>
															<li>You can undo a settled label.</li>
														</ul>
														<div className="d-plain-note">
															The connected version includes ordinary
															calibration and your resumable research batch.
															This draft rehearses the interaction with
															fictional songs.
														</div>
													</aside>
												</div>
											</div>
										)}
										{screen === "insights" && <ModelLab state={state} />}
										{screen === "library" && (
											<div className="d-page">
												<PageHeading
													eyebrow="Import library"
													title="Bring your collection along."
												>
													<p>
														Your Liked Songs, with their artist, album, and
														original saved date.
													</p>
												</PageHeading>
												<div className="d-import-layout">
													<div className="d-import-art">
														{demoTracks.slice(0, 4).map((t) => (
															<Art track={t} key={t.trackId} />
														))}
													</div>
													<div>
														<span className="d-status">
															Demo collection ready
														</span>
														<h2>
															{demoTracks.length} songs.
															<br />
															One fresh start.
														</h2>
														<p>
															These fictional songs let you try the whole
															sorting flow. Connecting Spotify happens in the
															working app, where account and import status are
															real.
														</p>
														<Button
															onClick={() => go("review")}
															trailingIcon={RiArrowRightLine}
														>
															Start with the demo
														</Button>
														<ButtonLink
															href="/#/library"
															variant="secondary"
															trailingIcon={RiArrowRightUpLine}
														>
															Open connected app
														</ButtonLink>
														<dl>
															<div>
																<dt>Library access</dt>
																<dd>Not connected</dd>
															</div>
															<div>
																<dt>Audio enrichment</dt>
																<dd>Optional · not connected</dd>
															</div>
															<div>
																<dt>Spotify writes</dt>
																<dd>None in this draft</dd>
															</div>
														</dl>
													</div>
												</div>
											</div>
										)}
									</motion.div>
								</AnimatePresence>
								{state.error && (
									<p role="alert" className="d-error">
										{state.error}
									</p>
								)}
							</main>
							{showPlayback && (
								<footer className="d-player">
									<div>
										{current && <Art track={current} title={false} />}
										<span>
											<strong>{current?.title ?? "Collection complete"}</strong>
											<small>
												{current ? artist(current) : "A good place to pause."}
											</small>
										</span>
									</div>
									<button
										type="button"
										className="d-player-preview"
										aria-label="Preview unavailable: fictional demo track"
										onClick={() => setDialog("audio")}
									>
										<RiHeadphoneLine size={20} />
										<span>
											<span className="d-preview-desktop">
												Preview unavailable
											</span>
											<span className="d-preview-mobile">No preview</span>
											<small>Fictional demo track</small>
										</span>
									</button>
									<span className="d-player-end">PLAYER 01 · DEMO</span>
									<Button
										variant="secondary"
										iconOnly
										leadingIcon={RiCloseLine}
										aria-label="Hide playback dock"
										onClick={() => setShowPlayback(false)}
									/>
								</footer>
							)}
						</div>
					</div>
				)}
				<output className="sr-only" aria-live="polite">
					{state.notice}
				</output>
				<dialog
					ref={dialogRef}
					className="d-dialog"
					onCancel={() => setDialog(null)}
					onKeyDown={(e) => {
						if (e.key === "Escape") setDialog(null);
					}}
					onClick={(e) => {
						if (e.target === e.currentTarget) setDialog(null);
					}}
					aria-labelledby="d-dialog-title"
				>
					<Button
						variant="secondary"
						className="d-dialog-close"
						iconOnly
						leadingIcon={RiCloseLine}
						aria-label="Close dialog"
						onClick={() => setDialog(null)}
					/>
					<h2 id="d-dialog-title">
						{dialog === "shortcuts"
							? "Let your hands do the sorting."
							: dialog === "audio"
								? "A quiet demo."
								: "Your space, your collection."}
					</h2>
					{dialog === "shortcuts" ? (
						<>
							<p>When you’re on the review screen:</p>
							<div className="d-shortcuts">
								{decisions.map((d) => (
									<div key={d.action}>
										<span>{d.label}</span>
										<kbd>{d.key}</kbd>
									</div>
								))}
								<div>
									<span>Undo latest decision</span>
									<kbd>Z</kbd>
								</div>
							</div>
						</>
					) : (
						<p>
							{dialog === "audio"
								? "These songs are fictional. Real browser playback and Spotify connection controls will stay part of the connected experience; this design draft doesn’t simulate audio."
								: "You’re exploring a local design draft. Choices stay in this tab and reset on reload. No Spotify account, library changes, or model training are involved."}
						</p>
					)}
				</dialog>
			</div>
		</MotionConfig>
	);
}
