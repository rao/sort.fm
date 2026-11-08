import type { ReviewState } from "../state/review";
import { RiArrowRightLine } from "@remixicon/react";
import { Button, ButtonLink } from "#ui/components/base/buttons/button";
import { Cover, EmptyState, Icon, Progress } from "./ui";
import { MusicLoading } from "./MusicLoading";
export function Library({
	state,
	onRetry,
}: {
	state: ReviewState;
	onRetry: () => void;
}) {
	const total = state.bootstrap?.queue.items.length ?? 0;
	if (!state.bootstrap && !state.error)
		return <MusicLoading message="Getting your demo ready." />;
	return (
		<div className="page library-page demo-library-page">
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
							<Icon name="library" size={14} /> Demo library • no Spotify writes
						</span>
					</div>
				</section>
				<section
					className="import-panel demo-start-panel"
					aria-labelledby="demo-start-title"
				>
					<span className="eyebrow">YOUR FIRST LISTEN</span>
					<h2 id="demo-start-title">
						{state.loading
							? "Getting the music ready…"
							: state.error
								? "Let's try that again."
								: total > 0
									? "Ready when you are."
									: "A little quiet in here."}
					</h2>
					<div className="import-stage" aria-live="polite">
						<span className="stage-icon">
							<Icon name={state.bootstrap && total > 0 ? "check" : "library"} />
						</span>
						<div>
							<strong>
								{state.loading
									? "Loading demo library"
									: state.error
										? "Demo temporarily unavailable"
										: `${total} songs ready to explore`}
							</strong>
							<p>
								{state.loading
									? "Reading the local song collection…"
									: "Real music. Simulated decisions."}
							</p>
						</div>
					</div>
					{state.loading && (
						<Progress
							smooth
							value={total}
							max={total || 1}
							label="Library import progress"
						/>
					)}
					{state.error && (
						<div className="inline-error" role="alert">
							<p>{state.error}</p>
							<Button variant="secondary" onClick={onRetry}>
								Try again
							</Button>
						</div>
					)}
					{state.bootstrap && total > 0 && (
						<>
							<p className="demo-start-copy">
								Play a preview, then swipe to Keep, Archive, Skip or Unlike.
								You can undo any decision.
							</p>
							<ButtonLink
								href="#/review"
								className="demo-start-button"
								trailingIcon={RiArrowRightLine}
							>
								Start demo sorting
							</ButtonLink>
						</>
					)}
					<p className="import-note">
						Your Spotify library stays untouched.
						<br />
						Demo decisions reset when you reload.
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
			) : null}
		</div>
	);
}
