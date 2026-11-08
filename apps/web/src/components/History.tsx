import { useState } from "react";
import type { ReviewResult } from "@sortfm/contracts";
import { Button } from "#ui/components/base/buttons/button";
import {
	correctionLocked,
	latestSkipDecisions,
	type CorrectionState,
} from "../state/corrections";
import type { ReviewState } from "../state/review";
import { actionLabels, actionPast } from "../state/review";
import { Cover, EmptyState, Icon } from "./ui";
export function History({
	state,
	onUndo,
	corrections,
}: {
	state: ReviewState;
	onUndo: (id: string) => void;
	corrections?: {
		state: CorrectionState;
		onCorrect(decision: ReviewResult): void;
		onUndo(labelId: string): void;
		onRetry(): void;
		onRefresh(): void;
	};
}) {
	const [filter, setFilter] = useState("all");
	const [search, setSearch] = useState("");
	const eligibleSkips = latestSkipDecisions(
		state.history.map(({ result }) => result),
	);
	const reviewLocked =
		state.busy ||
		state.retraining ||
		!!state.retry ||
		state.refreshing ||
		!!state.refreshError;
	const labelsLocked =
		!corrections || correctionLocked(corrections.state) || reviewLocked;
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
			{corrections && (
				<div className="flex flex-col gap-2 text-body-2-regular">
					{corrections.state.busy && <output>Saving preference change…</output>}
					{corrections.state.refreshing && (
						<output>Checking preference history…</output>
					)}
					{corrections.state.notice && (
						<output>{corrections.state.notice}</output>
					)}
					{corrections.state.error && (
						<p role="alert">{corrections.state.error}</p>
					)}
					{corrections.state.pending && !corrections.state.busy && (
						<p>
							A preference command needs recovery. Check the saved outcome or
							retry the same request.
						</p>
					)}
					{!corrections.state.busy &&
						(corrections.state.error || corrections.state.pending) && (
							<div className="flex flex-wrap gap-2">
								<Button
									variant="secondary"
									disabled={
										corrections.state.busy || corrections.state.refreshing
									}
									onClick={corrections.onRefresh}
								>
									Check preference history
								</Button>
								{corrections.state.pending && (
									<Button
										variant="secondary"
										disabled={
											corrections.state.busy || corrections.state.refreshing
										}
										onClick={corrections.onRetry}
									>
										Retry saved preference request
									</Button>
								)}
							</div>
						)}
				</div>
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
								{corrections &&
									eligibleSkips.has(result.decisionId) &&
									(() => {
										const label =
											corrections.state.labels.find(
												(candidate) =>
													candidate.trackId === result.trackId &&
													candidate.state === "active",
											) ??
											corrections.state.labels.find(
												(candidate) => candidate.trackId === result.trackId,
											);
										return (
											<div className="flex flex-col gap-2 pt-3 text-body-2-regular">
												{label && (
													<p>
														Preference label:{" "}
														{label.state === "active"
															? `${label.label === 1 ? "Remove" : "Keep"} active`
															: label.state}
														. Original Skip is unchanged.
													</p>
												)}
												{label?.state === "active" ? (
													label.canUndo && (
														<Button
															variant="secondary"
															disabled={labelsLocked}
															onClick={() => corrections.onUndo(label.labelId)}
														>
															Undo preference label
														</Button>
													)
												) : (
													<details>
														<summary className="cursor-pointer text-text-primary">
															Label Remove only
														</summary>
														<div className="flex flex-col gap-2 pt-2">
															<p>
																Save a Remove preference only. Spotify will not
																change. Original Skip stays in history; this is
																not a C2 reward.
															</p>
															<Button
																variant="secondary"
																disabled={labelsLocked}
																onClick={() => corrections.onCorrect(result)}
															>
																Confirm Remove preference
															</Button>
														</div>
													</details>
												)}
											</div>
										);
									})()}
							</div>
							<span
								className={`decision-tag ${result.status === "UNDONE" ? "restored" : result.action.toLowerCase()}`}
							>
								{result.status === "UNDONE"
									? result.action === "KEEP" || result.action === "SKIP"
										? `${actionLabels[result.action]} undone`
										: "Restored"
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
									!!state.refreshError ||
									!!corrections?.state.busy ||
									!!corrections?.state.pending
								}
								onClick={() => onUndo(result.decisionId)}
							>
								<Icon name="undo" size={15} />
								{result.status === "UNDONE"
									? result.action === "KEEP" || result.action === "SKIP"
										? "Undone"
										: "Restored"
									: "Undo"}
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
						? "These are persisted server decisions. Song details may be unavailable for previously reviewed tracks. "
						: "Demo history lives in this tab and resets on reload. "}
					For Archive or Unlike, Undo restores the like; Spotify may change its
					saved order. Undo for Keep or Skip changes only the review state.
				</p>
			</div>
		</div>
	);
}
