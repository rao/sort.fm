import type { ReviewState } from "../state/review";
import { Cover, Icon, Progress } from "./ui";
export function Dashboard({
	state,
	complete = false,
}: {
	state: ReviewState;
	complete?: boolean;
}) {
	const active = state.history.filter(
		({ result }) => result.status === "COMPLETE",
	);
	const count = (action: string) =>
		active.filter(({ result }) => result.action === action).length;
	const total = state.bootstrap!.queue.items.length;
	const keeps = active
		.filter(({ result }) => result.action === "KEEP")
		.slice(0, 4);
	return (
		<div className={`page dashboard-page ${complete ? "completion-page" : ""}`}>
			<header className="page-heading">
				{complete && (
					<div className="completion-mark">
						<Icon name="check" size={32} />
					</div>
				)}
				<span className="eyebrow">
					{complete ? "A LITTLE LESS NOISE" : "YOUR MUSIC, RECONSIDERED"}
				</span>
				<h1>
					{complete ? "That feels lighter." : "A library that feels like you."}
				</h1>
				<p>
					{complete
						? "You gave every song a moment. Keep that feeling."
						: "A little progress goes a long way. Pick up where you left off."}
				</p>
			</header>
			<div className="session-stats">
				{[
					["KEEP", "Keepers", "heart"],
					["ARCHIVE", "Archived", "archive"],
					["SKIP", "For another day", "skip"],
					["UNLIKE", "Let go", "unlike"],
				].map(([action, label, icon]) => (
					<div className={action!.toLowerCase()} key={action}>
						<Icon name={icon as "heart"} size={21} />
						<strong>{count(action!)}</strong>
						<span>{label}</span>
					</div>
				))}
			</div>
			<section className="session-progress surface">
				<div>
					<div>
						<h2>
							{complete
								? "Your demo session is complete"
								: "Your next chapter is waiting"}
						</h2>
						<p>
							{active.length} of {total} songs reviewed • {state.queue.length}{" "}
							in your queue
						</p>
					</div>
					{!complete && state.queue.length > 0 && (
						<a className="button primary" href="#/review">
							Keep sorting <Icon name="arrow" size={17} />
						</a>
					)}
				</div>
				<Progress
					value={active.length}
					max={total}
					label="Session review progress"
				/>
				<p className="fine-print">
					This session is a local demo. Your Spotify library hasn't changed.
				</p>
			</section>
			{keeps.length > 0 && (
				<section className="keepers">
					<div className="section-top">
						<h2>Still in your rotation.</h2>
						<a href="#/history" className="text-link">
							All decisions <Icon name="arrow" size={16} />
						</a>
					</div>
					<div className="keeper-grid">
						{keeps.map(({ item }) => (
							<article key={item.track.trackId}>
								<Cover track={item.track} />
								<h3>{item.track.title}</h3>
								<p>{item.track.artists[0]?.name}</p>
							</article>
						))}
					</div>
				</section>
			)}
			<div className="dashboard-links">
				<a href="#/history" className="button secondary">
					<Icon name="undo" size={17} /> Revisit your decisions
				</a>
				<a href="#/insights" className="button ghost">
					Explore your feedback <Icon name="arrow" size={17} />
				</a>
			</div>
			{count("SKIP") > 0 && (
				<p className="fine-print">
					Skipped songs stay unlabeled. Restore them from History when you're
					ready for another pass.
				</p>
			)}
		</div>
	);
}
