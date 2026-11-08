import { useState } from "react";
import type { ReviewState } from "../state/review";
import { actionPast } from "../state/review";
import { Cover, EmptyState, Icon } from "./ui";
export function History({
	state,
	onUndo,
}: {
	state: ReviewState;
	onUndo: (id: string) => void;
}) {
	const [filter, setFilter] = useState("all");
	const [search, setSearch] = useState("");
	const entries = state.history.filter(
		({ result, item }) =>
			(filter === "all" || result.action === filter) &&
			`${item?.track.title ?? result.trackId} ${item?.track.artists.map((artist) => artist.name).join(" ") ?? ""}`
				.toLowerCase()
				.includes(search.toLowerCase()),
	);
	return (
		<div className="page history-page">
			<header className="page-heading">
				<span className="eyebrow">ROOM TO CHANGE YOUR MIND</span>
				<h1>Nothing here is a final goodbye.</h1>
				<p>
					Your decisions, all in one place. Restore a song whenever you like.
				</p>
			</header>
			{state.retraining && (
				<output className="fine-print">
					Training is in progress. Undo will be available when it finishes.
				</output>
			)}
			<div className="history-toolbar">
				<fieldset className="filter-tabs" aria-label="Filter history">
					{[
						["all", "All decisions"],
						["KEEP", "Kept"],
						["ARCHIVE", "Archived"],
						["SKIP", "Skipped"],
						["UNLIKE", "Unliked"],
					].map(([value, label]) => (
						<button
							type="button"
							key={value}
							className={filter === value ? "active" : ""}
							aria-pressed={filter === value}
							onClick={() => setFilter(value!)}
						>
							{label}
						</button>
					))}
				</fieldset>
				<input
					aria-label="Search decision history"
					placeholder="Find a song or artist…"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			{entries.length ? (
				<div className="history-list">
					{entries.map(({ item, result }) => (
						<article className="history-row" key={result.decisionId}>
							{item ? (
								<Cover track={item.track} />
							) : (
								<span className="missing-cover">
									<Icon name="music" />
								</span>
							)}
							<div className="history-song">
								<h2>{item?.track.title ?? "Saved Spotify decision"}</h2>
								{result.mode === "spotify" &&
									/^[a-zA-Z0-9]{22}$/.test(result.trackId) && (
										<a
											className="text-link"
											href={`https://open.spotify.com/track/${result.trackId}`}
											target="_blank"
											rel="noreferrer"
										>
											Open in Spotify
										</a>
									)}
								<p>
									{item?.track.artists
										.map((artist) => artist.name)
										.join(", ") ?? result.trackId}
								</p>
							</div>
							<span
								className={`decision-tag ${result.status === "UNDONE" ? "restored" : result.action.toLowerCase()}`}
							>
								{result.status === "UNDONE"
									? "Restored"
									: result.status === "COMPLETE"
										? actionPast[result.action]
										: result.status.toLowerCase().replaceAll("_", " ")}
							</span>
							<span className="history-time">
								{new Date(result.updatedAt).toLocaleTimeString([], {
									hour: "numeric",
									minute: "2-digit",
								})}
							</span>
							<button
								type="button"
								className="button ghost small desk-undo"
								disabled={
									!result.canUndo ||
									state.busy ||
									state.retraining ||
									!!state.retry ||
									state.refreshing ||
									!!state.refreshError
								}
								onClick={() => onUndo(result.decisionId)}
							>
								<Icon name="undo" size={15} />
								{result.status === "UNDONE" ? "Restored" : "Undo"}
							</button>
						</article>
					))}
				</div>
			) : (
				<EmptyState
					icon="clock"
					title={
						state.history.length
							? "No songs match just yet"
							: "Your fresh start begins with one song"
					}
				>
					<p>
						{state.history.length
							? "Try another filter or search."
							: "Your decisions will appear here as you sort."}
					</p>
					<a className="button primary" href="#/review">
						Back to the music <Icon name="arrow" size={17} />
					</a>
				</EmptyState>
			)}
			{state.historyHasMore && (
				<p className="fine-print">
					Showing the latest saved decisions. Older history is not available in
					this view yet.
				</p>
			)}
			<div className="recovery-note">
				<Icon name="info" size={18} />
				<p>
					{state.bootstrap?.session.mode === "spotify"
						? "These are persisted server decisions. Song details may be unavailable for previously reviewed tracks. Archive saves a private playlist copy before unliking. Undo "
						: "Demo history lives in this tab and resets on reload. In a connected library, Archive saves a private playlist copy before unliking. Undo "}
					restores the like, but Spotify may change its saved order.
				</p>
			</div>
		</div>
	);
}
