import { demoTracks } from "@sortfm/contracts/fixtures";
import { RiArrowRightLine, RiSpotifyFill, RiPlayFill } from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import { Cover, Logo } from "./ui";
export function Landing({ onConnect }: { onConnect: () => void }) {
	const example = demoTracks[0]!;
	return (
		<div className="landing desk-landing">
			<header className="landing-nav">
				<Logo />
				<nav aria-label="Main navigation">
					<a href="#how-it-works">How it works</a>
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
							<Button leadingIcon={RiSpotifyFill} onClick={onConnect}>
								Bring my Spotify
							</Button>
							<a className="button secondary" href="?mode=demo#/review">
								Try demo <RiArrowRightLine size={18} />
							</a>
						</div>
						<small>No Spotify account needed for the demo.</small>
					</div>
					<div className="desk-device desk-hero-device">
						<div className="desk-device-label">
							<strong>sort.fm</strong>
							<span>Personal music sorter · 01</span>
							<i aria-hidden="true" />
						</div>
						<div className="desk-lcd desk-hero-lcd">
							<div className="desk-lcd-status">
								<span>Ready to rediscover</span>
								<span>Demo tape</span>
							</div>
							<Cover track={example} typography />
							<h2>{example.title}</h2>
							<p>
								{example.artists[0]?.name} / {example.album}
							</p>
							<div className="desk-equalizer" aria-hidden="true">
								{[
									14, 23, 9, 32, 19, 28, 12, 30, 17, 25, 10, 21, 34, 16, 27, 11,
									29, 18, 31, 13, 24,
								].map((h) => (
									<i key={h} style={{ height: h }} />
								))}
							</div>
						</div>
						<div className="desk-hero-wheel">
							<span>YOUR MUSIC</span>
							<a
								className="desk-power"
								href="?mode=demo#/review"
								aria-label="Power on the demo player"
							>
								<RiPlayFill size={30} />
							</a>
							<span>YOUR CALL</span>
						</div>
						<div className="desk-device-footer">
							<span>Designed for changing taste</span>
							<span aria-hidden="true">▦▦▦</span>
						</div>
					</div>
				</section>
				<section className="desk-how" id="how-it-works">
					<div>
						<span className="eyebrow">One song at a time</span>
						<h2>
							A little less scrolling.
							<br />A lot more listening.
						</h2>
					</div>
					<div>
						<p>
							Keep it, archive it, or come back later. Your choices help the
							model learn your taste; you make the final call.
						</p>
						<p className="fine-print">
							Archive keeps a playlist copy before unliking. Unlike removes
							directly. Teach saves preference labels without changing your
							library.
						</p>
					</div>
				</section>
			</main>
			<footer className="landing-footer">
				<Logo />
				<span>A little less noise. A lot more you.</span>
				<span>Made for changing taste.</span>
			</footer>
		</div>
	);
}
