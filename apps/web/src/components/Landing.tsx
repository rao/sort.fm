import { demoTracks } from "@sortfm/contracts/fixtures";
import { Cover, Icon, Logo } from "./ui";
export function Landing({ onConnect }: { onConnect: () => void }) {
	return (
		<div className="landing">
			<header className="landing-nav">
				<Logo />
				<nav aria-label="Main navigation">
					<a href="#how-it-works">How it works</a>
					<button type="button" className="button ghost" onClick={onConnect}>
						Connect Spotify <Icon name="external" size={15} />
					</button>
				</nav>
			</header>
			<main id="main">
				<section className="hero">
					<div className="hero-copy">
						<span className="eyebrow">
							<span className="tiny-wave" /> MAKE ROOM FOR WHAT MOVES YOU
						</span>
						<h1>
							Your taste evolved.
							<br />
							Your Liked Songs
							<br />
							<span>didn't.</span>
						</h1>
						<p>
							Rediscover the keepers. Let go of the rest.
							<br />A little space for the music you love now.
						</p>
						<div className="hero-ctas">
							<a className="button primary large" href="?mode=demo#/library">
								Find your next favorite. Again. <Icon name="arrow" />
							</a>
							<a className="demo-link" href="?mode=demo#/library">
								Try demo <span>No Spotify account needed</span>
							</a>
						</div>
					</div>
					<div
						className="hero-art"
						role="img"
						aria-label="A collection of original fictional album covers"
					>
						<div className="hero-album back-one">
							<Cover track={demoTracks[1]!} typography />
						</div>
						<div className="hero-album back-two">
							<Cover track={demoTracks[2]!} typography />
						</div>
						<div className="hero-album front">
							<Cover track={demoTracks[0]!} typography />
							<div className="hero-song">
								<div>
									<strong>After the Rain</strong>
									<span>Paper Satellites</span>
								</div>
								<span className="hero-heart">
									<Icon name="heart" size={25} />
								</span>
							</div>
						</div>
						<div className="floating-note">
							<Icon name="heart" size={15} /> Still hits. Keep it.
						</div>
					</div>
				</section>
				<section id="how-it-works" className="how-section">
					<div className="how-intro">
						<span className="eyebrow">LESS SCROLLING. MORE FEELING.</span>
						<h2>
							A fresh start.
							<br />
							One song at a time.
						</h2>
					</div>
					<div className="how-steps">
						<article>
							<span>01</span>
							<h3>Bring your library</h3>
							<p>
								Start with your Liked Songs, or explore a collection made for
								the demo.
							</p>
						</article>
						<article>
							<span>02</span>
							<h3>Go with your gut</h3>
							<p>
								Keep, archive, skip, or unlike. A swipe or an arrow key is all
								it takes.
							</p>
						</article>
						<article>
							<span>03</span>
							<h3>Make it yours again</h3>
							<p>
								Your decisions guide your library. You always have the final
								say.
							</p>
						</article>
					</div>
				</section>
			</main>
			<footer className="landing-footer">
				<Logo />
				<span>A little less noise. A lot more you.</span>
				<span>Made for the love of music.</span>
			</footer>
		</div>
	);
}
