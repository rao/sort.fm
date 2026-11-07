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
			`${item.track.title} ${item.track.artists.map((artist) => artist.name).join(" ")}`
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
							<Cover track={item.track} />
							<div className="history-song">
								<h2>{item.track.title}</h2>
								<p>
									{item.track.artists.map((artist) => artist.name).join(", ")}
								</p>
							</div>
							<span
								className={`decision-tag ${result.status === "UNDONE" ? "restored" : result.action.toLowerCase()}`}
							>
								{result.status === "UNDONE"
									? "Restored"
									: actionPast[result.action]}
							</span>
							<span className="history-time">
								{new Date(result.updatedAt).toLocaleTimeString([], {
									hour: "numeric",
									minute: "2-digit",
								})}
							</span>
							<button
								type="button"
								className="button ghost small"
								disabled={!result.canUndo || state.busy || !!state.retry}
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
			<div className="recovery-note">
				<Icon name="info" size={18} />
				<p>
					Demo history lives in this tab and resets on reload. In a connected
					library, Archive saves a private playlist copy before unliking. Undo
					restores the like, but Spotify may change its saved order.
				</p>
			</div>
		</div>
	);
}
