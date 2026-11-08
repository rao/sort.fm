import {
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	RiArrowRightLine,
	RiCloseLine,
	RiFullscreenLine,
	RiRefreshLine,
	RiSparklingLine,
} from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import { SearchField } from "#ui/components/base/search-field/search-field";
import {
	createSyntheticLibrary,
	audioFields,
	formatAudio,
	labelName,
	type Library,
	type Track,
} from "./data";
import { ConstellationError, loadLibrary } from "./client";
import { ConstellationCanvas } from "./ConstellationCanvas";
import {
	geometryKey,
	filterGraph,
	ProjectionCache,
	type MusicView,
} from "./history";
import type { Graph, GraphNode } from "./graph";
import "./constellation.css";

export function ConstellationExplorer({
	children,
	source,
}: {
	children: ReactNode;
	source: Library["mode"];
}) {
	const id = useId();
	const dialog = useRef<HTMLDialogElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		if (!expanded) return;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		closeButton.current?.focus();
		return () => {
			document.body.style.overflow = overflow;
		};
	}, [expanded]);
	const collapse = () => {
		dialog.current?.close();
		dialog.current?.show();
		setExpanded(false);
		trigger.current?.focus({ preventScroll: true });
	};
	return (
		<>
			<div className="tc-explorer-toolbar">
				<span className="text-caption-1-semibold">Explore the map</span>
				<Button
					ref={trigger}
					variant="secondary"
					size="small"
					leadingIcon={RiFullscreenLine}
					aria-haspopup="dialog"
					aria-controls={id}
					aria-expanded={expanded}
					onClick={() => {
						// An inline nonmodal dialog must close before entering the top layer.
						dialog.current?.close();
						dialog.current?.showModal();
						setExpanded(true);
					}}
				>
					Expand map
				</Button>
			</div>
			<dialog
				ref={dialog}
				id={id}
				open
				className="tc-explorer"
				aria-label="Taste constellation map"
				aria-modal={expanded || undefined}
				aria-describedby={expanded ? `${id}-source` : undefined}
				onCancel={(event) => {
					event.preventDefault();
					if (expanded) collapse();
				}}
				onKeyDownCapture={(event) => {
					if (expanded && event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						collapse();
					}
				}}
			>
				<div className="tc-expanded-header" hidden={!expanded}>
					<div>
						<h3 className="text-headline-medium">Taste Constellation</h3>
						<p id={`${id}-source`} className="text-caption-1-semibold">
							{source === "synthetic"
								? "SYNTHETIC DEMO · NOT YOUR LIBRARY"
								: "YOUR LIBRARY · READ ONLY"}
						</p>
					</div>
					<Button
						ref={closeButton}
						variant="secondary"
						size="small"
						leadingIcon={RiCloseLine}
						aria-label="Close expanded map"
						onClick={collapse}
					>
						Close
					</Button>
				</div>
				{children}
			</dialog>
		</>
	);
}

export function TrackDetails({
	track,
	library,
	node,
	tracks,
	onSelect,
	onClose,
}: {
	track: Track;
	library: Library;
	node: GraphNode | undefined;
	tracks: Map<string, Track>;
	onSelect: (id: string) => void;
	onClose: () => void;
}) {
	const prediction = track.prediction;
	const current =
		prediction &&
		library.modelVersion !== null &&
		prediction.modelVersion === library.modelVersion;
	return (
		<aside className="tc-detail" aria-label="Selected track details">
			<div className="tc-detail-top">
				<span className="text-caption-1-semibold">SELECTED TRACK</span>
				<Button
					size="small"
					variant="ghost"
					iconOnly
					leadingIcon={RiCloseLine}
					aria-label="Clear track selection"
					onClick={onClose}
				/>
			</div>
			<div className="tc-track-heading">
				{track.imageUrl ? (
					<img
						className="tc-art"
						src={track.imageUrl}
						alt={`${track.title} artwork`}
						referrerPolicy="no-referrer"
						loading="lazy"
					/>
				) : (
					<div
						className="tc-art tc-art-empty"
						role="img"
						aria-label="Artwork unavailable"
					>
						<RiSparklingLine aria-hidden="true" />
					</div>
				)}
				<div>
					<h3 className="text-headline-medium">{track.title}</h3>
					<p className="text-body-2-regular">{track.artist}</p>
				</div>
			</div>
			<span
				className="tc-label text-caption-1-semibold"
				data-label={track.label ?? "unlabeled"}
			>
				{labelName(track.label)}
				{library.mode === "synthetic"
					? " · demo label"
					: track.label
						? " · explicit feedback"
						: " · no explicit label"}
			</span>
			<p className="tc-membership text-caption-1-regular">
				{track.isLiked
					? "Currently liked in Spotify"
					: "In your music history · no longer liked"}
				{library.mode === "synthetic" ? " · demo state" : ""}. Preference
				feedback does not change this membership.
			</p>
			{!node && (
				<p className="tc-notice text-body-2-regular">
					Not placed: too few varying audio descriptors. This song has no
					similarity edges.
				</p>
			)}
			<section className="tc-detail-section">
				<h4 className="text-body-medium">Musical properties</h4>
				<dl className="tc-properties text-caption-1-regular">
					{audioFields.map(([key, title]) => (
						<div key={key}>
							<dt>{title}</dt>
							<dd>{formatAudio(key, track.audio[key])}</dd>
						</div>
					))}
				</dl>
				<p className="text-caption-1-regular">
					{library.mode === "synthetic"
						? "Generated descriptors for this demo."
						: "Observed cached descriptors. Missing values stay unavailable."}
				</p>
			</section>
			<section className="tc-detail-section">
				<h4 className="text-body-medium">
					{current ? "Current C1 removal estimate" : "C1 removal estimate"}
				</h4>
				{prediction ? (
					<>
						<strong className="tc-estimate text-title-2-medium">
							{(prediction.removalProbability * 100).toFixed(1)}%
						</strong>
						<p className="text-caption-1-regular">
							{current
								? "Current model snapshot"
								: "Stored prediction · current version not confirmed"}{" "}
							· {prediction.calibrated ? "Calibrated" : "Uncalibrated"}
							<br />
							<code>{prediction.modelVersion}</code>
							<br />
							<time dateTime={prediction.scoredAt}>
								{new Date(prediction.scoredAt).toLocaleString()}
							</time>
						</p>
						{prediction.explanations.length ? (
							<details>
								<summary className="text-body-2-medium">
									Why this saved prediction?
								</summary>
								<p className="text-caption-1-regular">
									Signed model contributions, not causal explanations. Positive
									terms push toward Remove; negative terms toward Keep.
								</p>
								<ul className="tc-contributions">
									{prediction.explanations.map((e, i) => (
										<li key={`${e.feature}-${i}`}>
											<b>{e.feature.replaceAll("_", " ")}</b>
											<span>
												{e.contribution == null
													? "Unavailable"
													: `${e.contribution > 0 ? "+" : ""}${e.contribution.toFixed(3)}`}
											</span>
											<p>{e.description}</p>
										</li>
									))}
								</ul>
							</details>
						) : (
							<p className="text-caption-1-regular">
								No prediction explanations supplied.
							</p>
						)}
					</>
				) : (
					<p className="text-body-2-regular">
						{library.mode === "synthetic"
							? "No model predictions in this demo."
							: "No current score supplied. Acoustic proximity is not a removal estimate."}
					</p>
				)}
			</section>
			<section className="tc-detail-section">
				<h4 className="text-body-medium">Nearest acoustic neighbors</h4>
				<p className="text-caption-1-regular">
					Ranked in full feature space. Smaller distance means more similar
					observed audio, not more similar taste.
				</p>
				{node?.neighbors.length ? (
					<ol className="tc-neighbors">
						{node.neighbors.map((neighbor) => {
							const other = tracks.get(neighbor.id)!;
							return (
								<li key={neighbor.id}>
									<Button
										className="text-button"
										variant="ghost"
										trailingIcon={RiArrowRightLine}
										onClick={() => onSelect(neighbor.id)}
									>
										<span className="tc-song-copy">
											<b className="text-body-2-medium">{other.title}</b>
											<small className="text-caption-1-regular">
												{neighbor.shared} shared features · distance{" "}
												{neighbor.distance.toFixed(2)}
											</small>
										</span>
									</Button>
								</li>
							);
						})}
					</ol>
				) : (
					<p className="text-caption-1-regular">
						No comparable neighbors available.
					</p>
				)}
			</section>
		</aside>
	);
}

export function TasteConstellation({
	connected,
	projectionCache,
	refreshKey = "",
}: {
	connected: boolean;
	projectionCache?: ProjectionCache;
	refreshKey?: string;
}) {
	const [cache] = useState(() => projectionCache ?? new ProjectionCache());
	const [view, setView] = useState<MusicView>("history");
	const [reading, setReading] = useState(false);
	const previousSource = useRef("live");
	const [source, setSource] = useState<"live" | "synthetic">("live");
	const [library, setLibrary] = useState<Library | null>(null);
	const [projection, setProjection] = useState<{
		key: string;
		graph: Graph;
	} | null>(null);
	const [error, setError] = useState("");
	const [graphError, setGraphError] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [missingOnly, setMissingOnly] = useState(false);
	const [page, setPage] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt and refreshKey explicitly invalidate the readonly snapshot.
	useEffect(() => {
		if (previousSource.current !== source) {
			setLibrary(null);
			setSelected(null);
			setQuery("");
			setMissingOnly(false);
			setPage(0);
			previousSource.current = source;
		}
		setError("");
		setReading(false);
		if (source === "synthetic") {
			setLibrary(createSyntheticLibrary());
			return;
		}
		if (!connected) {
			setLibrary(null);
			return;
		}
		setReading(true);
		const controller = new AbortController();
		let disposed = false;
		const timeout = setTimeout(() => {
			controller.abort();
			if (!disposed) {
				setLibrary(null);
				setReading(false);
				setError("The library request timed out. Please try again.");
			}
		}, 20_000);
		void loadLibrary({
			signal: controller.signal,
			baseUrl: import.meta.env.VITE_API_ORIGIN,
		})
			.then((data) => {
				if (!disposed && !controller.signal.aborted) setLibrary(data);
			})
			.catch((cause) => {
				if (!disposed && !controller.signal.aborted) {
					setLibrary(null);
					setError(
						cause instanceof ConstellationError
							? cause.message
							: "The library map could not be loaded.",
					);
				}
			})
			.finally(() => {
				clearTimeout(timeout);
				if (!disposed) setReading(false);
			});
		return () => {
			disposed = true;
			controller.abort();
			clearTimeout(timeout);
		};
	}, [connected, source, attempt, refreshKey]);
	useEffect(() => {
		if (source !== "live" || !connected) return;
		const refresh = () => {
			if (!document.hidden) setAttempt((a) => a + 1);
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [source, connected]);

	// Never present the previous source's data even for the render before cleanup.
	const currentLibrary = library?.mode === source ? library : null;
	const inputKey = useMemo(
		() => (currentLibrary ? geometryKey(currentLibrary.tracks) : null),
		[currentLibrary],
	);
	const graph = projection?.key === inputKey ? projection.graph : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry can restart a failed worker without changing acoustic inputs.
	useEffect(() => {
		setGraphError("");
		if (!inputKey) return;
		const cached = cache.read(source, inputKey);
		if (cached) {
			setProjection({ key: inputKey, graph: cached });
			return;
		}
		let worker: Worker;
		try {
			worker = new Worker(new URL("./graph.worker.ts", import.meta.url), {
				type: "module",
			});
		} catch {
			setGraphError(
				"The map worker could not start. Other Model Lab tabs remain available.",
			);
			return;
		}
		const timeout = setTimeout(() => {
			worker.terminate();
			setGraphError("Map calculation timed out. Please retry.");
		}, 20_000);
		worker.onmessage = (
			event: MessageEvent<{ ok: boolean; graph?: Graph }>,
		) => {
			clearTimeout(timeout);
			if (event.data.ok && event.data.graph) {
				cache.write(source, inputKey, event.data.graph);
				setProjection({ key: inputKey, graph: event.data.graph });
			} else setGraphError("The map could not be calculated. Please retry.");
		};
		worker.onerror = () => {
			clearTimeout(timeout);
			setGraphError("The map worker stopped. Please retry.");
		};
		worker.postMessage(JSON.parse(inputKey));
		return () => {
			clearTimeout(timeout);
			worker.terminate();
		};
	}, [inputKey, source, cache, attempt]);
	const visibleLibraryTracks = useMemo(
		() =>
			(currentLibrary?.tracks ?? []).filter(
				(t) => view === "history" || t.isLiked,
			),
		[currentLibrary, view],
	);
	const visibleGraph = useMemo(
		() =>
			graph && currentLibrary
				? filterGraph(graph, currentLibrary.tracks, view)
				: null,
		[graph, currentLibrary, view],
	);

	const tracks = useMemo(
		() => new Map(visibleLibraryTracks.map((t) => [t.id, t])),
		[visibleLibraryTracks],
	);
	const unplaced = useMemo(
		() => new Set(visibleGraph?.unplaced ?? []),
		[visibleGraph],
	);
	const searchResults = useMemo(() => {
		const search = query.trim().toLocaleLowerCase();
		return visibleLibraryTracks.filter(
			(t) =>
				(!missingOnly || unplaced.has(t.id)) &&
				`${t.title} ${t.artist}`.toLocaleLowerCase().includes(search),
		);
	}, [visibleLibraryTracks, query, missingOnly, unplaced]);
	const track = tracks.get(selected ?? "");
	const ready = currentLibrary && graph && visibleGraph;
	useEffect(() => {
		if (selected && !tracks.has(selected)) setSelected(null);
	}, [tracks, selected]);
	const busy =
		(source === "synthetic" || connected) && !error && !graphError && !ready;
	const select = (id: string | null) => {
		setSelected(id);
	};

	return (
		<section className="ml-window tc-root" aria-labelledby="tc-title">
			<header>
				<h2 id="tc-title">05 / Taste Constellation</h2>
				<span>
					{source === "synthetic"
						? "SYNTHETIC DEMO · NOT YOUR LIBRARY"
						: "YOUR LIBRARY · READ ONLY"}
				</span>
			</header>
			<div className="tc-intro">
				<div>
					<p className="tc-kicker text-caption-1-semibold">
						A MAP OF SOUND <span>– hear the connections</span>
					</p>
					<p className="text-body-2-regular">
						Explore songs through their musical properties. Nearby sounds can
						lead to very different preferences.
					</p>
				</div>
				<div className="tc-source-actions">
					{source === "synthetic" ? (
						<Button variant="secondary" onClick={() => setSource("live")}>
							Back to my library
						</Button>
					) : (
						<Button
							variant="secondary"
							leadingIcon={RiSparklingLine}
							onClick={() => setSource("synthetic")}
						>
							Explore synthetic demo
						</Button>
					)}
					{connected && source === "live" && (
						<Button
							variant="secondary"
							iconOnly
							leadingIcon={RiRefreshLine}
							aria-label="Reload library map"
							disabled={busy || reading}
							onClick={() => setAttempt((a) => a + 1)}
						/>
					)}
				</div>
			</div>
			{source === "synthetic" && (
				<p className="tc-demo-banner text-body-2-medium">
					DEMO DATA · 2,700 invented songs and generated descriptors. Labels are
					illustrative; no real preferences or model predictions are shown.
				</p>
			)}
			{!connected && source === "live" && (
				<div className="tc-status">
					<h3 className="text-headline-medium">Your library belongs here.</h3>
					<p>
						Connect Spotify to load eligible songs and their observed audio. The
						demo is available above.
					</p>
				</div>
			)}
			{(error || graphError) && (
				<div className="tc-status" role="alert">
					<h3 className="text-headline-medium">Map unavailable</h3>
					<p>{error || graphError}</p>
					<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
						Try again
					</Button>
				</div>
			)}
			{busy && (
				<div className="tc-status" aria-live="polite">
					<span className="tc-loading-mark" aria-hidden="true">
						✦
					</span>
					<h3 className="text-headline-medium">
						{currentLibrary
							? "Finding acoustic neighbors…"
							: "Loading your library…"}
					</h3>
					<p>
						{currentLibrary
							? "Projecting observed audio into two dimensions. You can keep using Model Lab."
							: "Only eligible songs will enter this map."}
					</p>
				</div>
			)}
			{ready && (
				<>
					<div className="tc-view-controls">
						<fieldset aria-label="Music view">
							{(
								[
									["history", "Your Music History"],
									["current", "Current Liked Songs"],
								] as const
							).map(([mode, title]) => (
								<Button
									key={mode}
									variant={view === mode ? "primary" : "secondary"}
									aria-pressed={view === mode}
									onClick={() => {
										setView(mode);
										setPage(0);
									}}
								>
									{title}
								</Button>
							))}
						</fieldset>
						<p className="text-caption-1-regular">
							Same map, same positions. Colors show eligible preferences from
							Teach and Sort; membership is separate.
						</p>
						{reading && (
							<output className="text-caption-1-regular">
								Refreshing labels and membership…
							</output>
						)}
					</div>
					<section
						className="tc-summary text-caption-1-regular"
						aria-label="Graph coverage"
					>
						<span>
							<b>{visibleGraph.nodes.length.toLocaleString()}</b> placed /{" "}
							{visibleLibraryTracks.length.toLocaleString()} in this view
						</span>
						<span>
							<b>{graph.activeFeatures.length}</b> varying descriptors
						</span>
						<span>
							<b>
								{graph.nodes.length
									? `${((graph.variance[0] + graph.variance[1]) * 100).toFixed(1)}%`
									: "—"}
							</b>{" "}
							projected variance
						</span>
						<span className="tc-legend">
							<i data-label="keep" /> Keep <i data-label="remove" /> Remove{" "}
							<i data-label="unlabeled" /> Unlabeled
						</span>
					</section>
					<div className="tc-search-row">
						<SearchField
							aria-label="Search constellation tracks"
							placeholder="Find a song or artist…"
							value={query}
							onChange={(value) => {
								setQuery(value);
								setPage(0);
							}}
							onSubmit={() => {
								if (searchResults[page * 8])
									select(searchResults[page * 8]!.id);
							}}
						/>
						<Button
							variant="secondary"
							size="small"
							aria-pressed={missingOnly}
							onClick={() => {
								setMissingOnly(!missingOnly);
								setPage(0);
							}}
						>
							Needs audio ({visibleGraph.unplaced.length})
						</Button>
					</div>
					{(query || missingOnly) && (
						<div className="tc-search-results">
							<p className="text-caption-1-regular" aria-live="polite">
								{searchResults.length.toLocaleString()} matching songs
								{missingOnly ? " · unplaced" : ""}
							</p>
							<div>
								{searchResults.slice(page * 8, page * 8 + 8).map((t) => (
									<Button
										variant="secondary"
										size="small"
										key={t.id}
										aria-pressed={t.id === selected}
										onClick={() => select(t.id)}
									>
										{t.title} · {t.artist}
									</Button>
								))}
							</div>
							{searchResults.length > 8 && (
								<div className="tc-pagination">
									<Button
										size="small"
										variant="ghost"
										disabled={page === 0}
										onClick={() => setPage(page - 1)}
									>
										Previous results
									</Button>
									<span>
										{page + 1} / {Math.ceil(searchResults.length / 8)}
									</span>
									<Button
										size="small"
										variant="ghost"
										disabled={(page + 1) * 8 >= searchResults.length}
										onClick={() => setPage(page + 1)}
									>
										Next results
									</Button>
								</div>
							)}
						</div>
					)}
					<ConstellationExplorer source={currentLibrary.mode}>
						<div className="tc-layout">
							{graph.nodes.length ? (
								<ConstellationCanvas
									graph={graph}
									visibleGraph={visibleGraph}
									tracks={tracks}
									selected={selected}
									onSelect={select}
								/>
							) : (
								<div className="tc-status">
									<h3 className="text-headline-medium">
										{currentLibrary.tracks.length
											? "Not enough observed audio yet."
											: "No eligible songs available."}
									</h3>
									<p>
										{currentLibrary.tracks.length
											? "Songs remain searchable. At least three varying descriptors and sufficient shared observations are needed to place them."
											: "No synthetic songs have been substituted. Refresh after your library is available."}
									</p>
								</div>
							)}
							{track ? (
								<TrackDetails
									track={track}
									library={currentLibrary}
									node={visibleGraph.nodes.find((n) => n.id === track.id)}
									tracks={tracks}
									onSelect={select}
									onClose={() => select(null)}
								/>
							) : (
								<aside className="tc-detail tc-invitation">
									<RiSparklingLine aria-hidden="true" />
									<p className="tc-kicker text-caption-1-semibold">
										FOLLOW YOUR CURIOSITY
									</p>
									<h3 className="text-title-3-semibold">
										Every point is a song.
									</h3>
									<p className="text-body-2-regular">
										Select one to see its closest acoustic neighbors, available
										descriptors and recorded preference.
									</p>
									<div className="tc-mini-legend text-caption-1-regular">
										<span>
											<span data-label="keep" aria-hidden="true">
												●
											</span>{" "}
											Keep
										</span>
										<span>
											<span data-label="remove" aria-hidden="true">
												◆
											</span>{" "}
											Remove
										</span>
										<span>
											<span data-label="unlabeled" aria-hidden="true">
												●
											</span>{" "}
											Unlabeled
										</span>
									</div>
									<h4 className="text-body-medium">
										{visibleLibraryTracks.length
											? "Start exploring"
											: "No songs in this view"}
									</h4>
									{!visibleLibraryTracks.length && (
										<p className="text-body-2-regular">
											No eligible songs are currently liked according to the
											synchronized library. Your history stays available in the
											other view.
										</p>
									)}
									<ul className="tc-neighbors">
										{visibleLibraryTracks.slice(0, 4).map((t) => (
											<li key={t.id}>
												<Button
													className="text-button"
													variant="ghost"
													trailingIcon={RiArrowRightLine}
													onClick={() => select(t.id)}
												>
													<span className="tc-song-copy">
														<b className="text-body-2-medium">{t.title}</b>
														<small className="text-caption-1-regular">
															{t.artist}
														</small>
													</span>
												</Button>
											</li>
										))}
									</ul>
								</aside>
							)}
						</div>
					</ConstellationExplorer>
					<div className="tc-method">
						<p className="text-body-2-medium">
							Sound explains the map. Your feedback teaches C1.
						</p>
						<p className="text-caption-1-regular">
							Lines connect nearest observed sounds, not learned neural
							connections. Colors show explicit labels only. A song’s location
							never determines its removal score.
						</p>
						<details>
							<summary className="text-body-2-medium">
								How to read this projection
							</summary>
							<p>
								Descriptors are standardized using observed values in this
								eligible snapshot. Constant or unsupported features are
								excluded. PCA uses feature-mean imputation for missing values,
								which can draw incomplete songs toward the center. The displayed
								variance describes the imputed matrix, not model quality.
							</p>
							<p>
								Neighbor distance is the root mean squared difference across
								shared standardized descriptors, with at least {graph.minShared}{" "}
								shared features required. Up to six neighbors are shown per
								selection. Optional background links connect mutual top-three
								neighbors. PCA compresses information: proximity on screen can
								differ from full-feature similarity. No genre boundaries or
								learned centroid locations are invented.
							</p>
							<p>
								Unplaced songs lack enough varying audio features; they remain
								searchable. The map is deterministic for the same eligible data,
								and may shift when its songs or observed audio change. Switching
								views or updating preferences and membership preserves the same
								embedding. In Current Liked Songs, links show only original
								acoustic neighbors that are also currently liked.
							</p>
						</details>
						{source === "live" && (
							<p className="text-caption-1-regular">
								Last library sync:{" "}
								{currentLibrary.membershipSyncedAt ? (
									<time dateTime={currentLibrary.membershipSyncedAt}>
										{new Date(
											currentLibrary.membershipSyncedAt,
										).toLocaleString()}
									</time>
								) : (
									"not confirmed"
								)}
								. Confirmed Sort and Undo actions update membership separately.
								External Spotify changes appear after library sync.
							</p>
						)}
						<p className="text-caption-1-regular">
							{source === "live" ? (
								<>
									Eligible snapshot:{" "}
									<time dateTime={currentLibrary.generatedAt}>
										{new Date(currentLibrary.generatedAt).toLocaleString()}
									</time>
									. Evaluation identities are excluded by the server before
									delivery.
								</>
							) : (
								"Synthetic data stays separate from your connected account. Nothing here trains a model or changes Spotify."
							)}
						</p>
					</div>
				</>
			)}
		</section>
	);
}
