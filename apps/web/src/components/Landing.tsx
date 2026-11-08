import { demoTracks } from "../data/demo-catalog";
import {
	RiArchiveLine,
	RiArrowGoBackLine,
	RiArrowRightLine,
	RiArrowUpLine,
	RiEqualizerLine,
	RiHeartLine,
	RiSpotifyFill,
	RiThumbDownLine,
} from "@remixicon/react";
import { Button, ButtonLink } from "#ui/components/base/buttons/button";
import { Cover, Logo, duration } from "./ui";
import "../styles/landing-refinements.css";
export function Landing({ onConnect }: { onConnect: () => void }) {
	const example = demoTracks[0]!;
	return (
		<div className="landing desk-landing">
			<header className="landing-nav">
				<Logo />
				<nav aria-label="Main navigation">
					<Button
						variant="secondary"
						leadingIcon={RiSpotifyFill}
						onClick={onConnect}
					>
						Connect Spotify
					</Button>
				</nav>
			</header>
			<main id="main" tabIndex={-1}>
				<section className="desk-hero">
					<div className="desk-hero-copy">
						<p className="eyebrow">
							A little desktop for your big music feelings
						</p>
						<h1>
							Old favorites.
							<br />
							<em>New feelings.</em>
						</h1>
						<p>
							Your Liked Songs, reloaded. Rediscover what still hits, and make
							room for what’s next.
						</p>
						<div className="desk-hero-actions">
							<Button
								className="desk-hero-cta"
								leadingIcon={RiSpotifyFill}
								onClick={onConnect}
							>
								Bring my Spotify
							</Button>
							<ButtonLink
								className="button secondary desk-hero-cta"
								variant="secondary"
								trailingIcon={RiArrowRightLine}
								href="?mode=demo#/review"
							>
								Try demo
							</ButtonLink>
						</div>
						<small>No Spotify account needed for the demo.</small>
					</div>
					<section className="desk-device desk-hero-device" aria-label="Preview of the song sorter">
						<div className="desk-device-label">
							<strong>sort.fm</strong>
							<span>Personal music sorter · 01</span>
							<i aria-hidden="true" />
						</div>
						<div className="desk-lcd">
							<div className="desk-lcd-status">
								<span><i aria-hidden="true" />Ready to rediscover</span>
								<span>Demo preview</span>
							</div>
							<Cover track={example} typography className="main-art" />
							<div className="song-details">
								<div className="song-title-line">
									<h2>{example.title}</h2>
									<span className="duration">{duration(example.durationMs)}</span>
								</div>
								<p>{example.artists[0]?.name} <span>•</span> {example.album}</p>
							</div>
						</div>
						<div className="desk-device-controls">
							<div className="desk-device-side" aria-hidden="true">
								<span className="desk-preview-side-key"><RiArrowGoBackLine size={18} /></span>
								<span>Undo</span>
							</div>
							<div className="desk-wheel">
								{/* Decision labels illustrate the real wheel; only the demo link is interactive. */}
								<div className="desk-preview-choice desk-preview-archive" aria-hidden="true">
									<RiArchiveLine size={16} /><span>Archive</span>
								</div>
								<div className="desk-preview-choice desk-preview-skip" aria-hidden="true">
									<RiArrowUpLine size={16} /><span>Skip</span>
								</div>
								<div className="desk-preview-choice desk-preview-keep" aria-hidden="true">
									<RiHeartLine size={16} /><span>Keep</span>
								</div>
								<div className="desk-preview-choice desk-preview-unlike" aria-hidden="true">
									<RiThumbDownLine size={16} /><span>Unlike</span>
								</div>
								<ButtonLink
									className="desk-preview-start"
									iconOnly
									leadingIcon={RiArrowRightLine}
									href="?mode=demo#/review"
									aria-label="Try the demo song sorter"
									title="Try the demo song sorter"
								/>
							</div>
							<div className="desk-device-side" aria-hidden="true">
								<span className="desk-preview-side-key"><RiEqualizerLine size={18} /></span>
								<span>Details</span>
							</div>
						</div>
						<div className="desk-device-footer">
							<span>Try the demo to start swiping.</span>
							<span aria-hidden="true">← ↑ ↓ →</span>
						</div>
					</section>
				</section>
				<section className="desk-how" id="how-it-works">
					<div>
						<span className="eyebrow">One song swipe at a time</span>
						<h2>
							Swipe through your music.
							<br />Keep what still hits.
						</h2>
					</div>
					<div>
						<p>
							Swipe right to keep, left to archive, up to skip, or down to
							unlike. Your swipes teach the model your taste; you make the
							final call.
						</p>
						<p className="fine-print">
							Archive keeps a playlist copy before unliking. Unlike removes
							directly. Teaching mode saves preference labels without changing
							your library.
						</p>
					</div>
				</section>
			</main>
			<footer className="landing-footer">
				<Logo />
				<span>
					A little less clutter. A lot more of the <em>evolved</em> you.
				</span>
				<span className="landing-credit">
					Made with{" "}
					<span role="img" aria-label="love">
						❤️
					</span>{" "}
					by <a href="https://raminr.ai">Ramin</a>
				</span>
			</footer>
		</div>
	);
}
