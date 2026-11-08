import type { ReviewState } from "../state/review";
import { Cover, EmptyState, Icon, Progress } from "./ui";
export function Library({
	state,
	onRetry,
}: {
	state: ReviewState;
	onRetry: () => void;
}) {
	const total = state.bootstrap?.queue.items.length ?? 0;
	return (
		<div className="page library-page">
			<header className="page-heading">
				<span className="eyebrow">A NEW CHAPTER FOR YOUR LIBRARY</span>
				<h1>Good music. A little more room.</h1>
				<p>Let's find the songs that still feel like you.</p>
			</header>
			<div className="import-layout">
				<section className="library-collection">
					<div className="collection-art">
						{state.bootstrap
							? state.bootstrap.queue.items
									.slice(0, 4)
									.map((item) => (
										<Cover key={item.track.trackId} track={item.track} />
									))
							: ["first", "second", "third", "fourth"].map((slot) => (
									<div key={slot} className="skeleton" />
								))}
					</div>
					<div className="collection-copy">
						<span className="eyebrow">YOUR DEMO COLLECTION</span>
						<h2>
							{state.loading
								? "Finding the good stuff…"
								: `${total} songs. Countless possibilities.`}
						</h2>
						<p>
							Forty favorites from the 1970s–2000s, with real artwork and
							streamed audio previews. Saved dates are simulated.
						</p>
						<span className="subtle-tag">
							<Icon name="library" size={14} /> Demo library • no Spotify
							writes
						</span>
					</div>
				</section>
				<section className="import-panel">
					<h2>Your library, coming into focus</h2>
					<div className="import-stage">
						<span className={`stage-icon ${state.loading ? "spinning" : ""}`}>
							<Icon name={state.bootstrap ? "check" : "library"} />
						</span>
						<div>
							<strong>
								{state.loading
									? "Loading demo library"
									: state.error
										? "Import paused"
										: "Demo library ready"}
							</strong>
							<p>
								{state.loading
									? "Reading the local song collection…"
									: `${total} of ${total} songs available`}
							</p>
						</div>
					</div>
					<Progress
						smooth
						value={total}
						max={total || 12}
						label="Library import progress"
					/>
					<div className="import-stage secondary">
						<span className="stage-icon">
							<Icon name="spark" />
						</span>
						<div>
							<strong>Audio enrichment</strong>
							<p>Not connected in demo</p>
						</div>
						<span className="small-badge">OPTIONAL</span>
					</div>
					<p className="fine-print">
						SoundNet features load separately in a connected library. You can
						start sorting before they're ready.
					</p>
					{state.error && (
						<div className="inline-error" role="alert">
							<p>{state.error}</p>
							<button
								type="button"
								className="button secondary"
								onClick={onRetry}
							>
								Retry library import
							</button>
						</div>
					)}
					{state.bootstrap && total > 0 && (
						<a href="#/review" className="button primary wide">
							Start demo sorting <Icon name="arrow" size={18} />
						</a>
					)}
					{state.loading && (
						<output className="button secondary wide">
							Loading your collection…
						</output>
					)}
					<p className="import-note">
						Nothing changes on Spotify in this demo.
					</p>
				</section>
			</div>
			{state.bootstrap && total === 0 ? (
				<EmptyState title="A clean slate">
					<p>There are no songs in this collection yet.</p>
					<a className="button primary" href="#/">
						Back to home
					</a>
				</EmptyState>
			) : (
				<div className="onboarding-note">
					<Icon name="headphones" size={23} />
					<div>
						<h3>No pressure. Just your taste.</h3>
						<p>
							Start with a few songs from different artists and eras. You can
							pause sorting anytime.
						</p>
					</div>
					<a className="text-link" href="#/review">
						Jump straight in <Icon name="arrow" size={16} />
					</a>
				</div>
			)}
		</div>
	);
}
