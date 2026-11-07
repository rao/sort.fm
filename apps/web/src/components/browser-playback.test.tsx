import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserPlaybackView } from "./BrowserPlayback";
import { BrowserPlayerStore } from "../state/browser-player";
import { liveFixture } from "../test-support/live-fixture";
const noop = () => {};
function props() {
	const track = liveFixture().items[0]!.track;
	const store = new BrowserPlayerStore(
		{ authorize: async () => {}, token: async () => "", play: async () => {} },
		async () => {
			throw new Error("Unused");
		},
		{ volumeSupported: true },
	);
	return {
		state: store.getSnapshot(),
		track,
		connection: {
			status: "ready" as const,
			sdkReady: true,
			controlReady: true,
			reason: null,
		},
		checking: false,
		error: null,
		now: Date.now(),
		onEnable: noop,
		onConnect: noop,
		onCheck: noop,
		onPlay: noop,
		onPause: noop,
		onSeek: noop,
		onMute: noop,
		onVolume: noop,
		onAuto: noop,
	};
}
test("browser player starts behind an explicit click and does not offer library mutations", () => {
	const p = props();
	const html = renderToStaticMarkup(<BrowserPlaybackView {...p} />);
	for (const text of [
		p.track.title,
		"Enable browser player",
		"Seek within this song",
		"Playback volume",
		"Play each new song",
		"Open in Spotify",
	])
		expect(html).toContain(text);
	for (const text of ["Would remove", "Archive", "Unlike", "Undo label"])
		expect(html).not.toContain(text);
	expect(html).not.toContain('type="checkbox" checked');
});
test("reconnect and unavailable connection states never claim the browser is playing", () => {
	const p = props();
	const html = renderToStaticMarkup(
		<BrowserPlaybackView
			{...p}
			connection={{
				status: "reconnect_required",
				sdkReady: false,
				controlReady: false,
				reason: "Authorize streaming",
			}}
		/>,
	);
	expect(html).toContain("Connect Spotify playback");
	expect(html).toContain("Authorize streaming");
	expect(html).not.toContain(">Pause<");
});
test("iOS uses hardware volume and only matching actual playback enables seeking", () => {
	const p = props();
	p.state = {
		...p.state,
		connection: "ready",
		volumeSupported: false,
		actualUri: "spotify:track:another",
		selectedUri: p.track.spotifyUri,
		canSeek: true,
		paused: false,
	};
	const html = renderToStaticMarkup(<BrowserPlaybackView {...p} />);
	expect(html).toContain("Use your device&#x27;s volume buttons");
	expect(html).not.toContain('aria-label="Playback volume"');
	expect(html).toContain("Play this song");
	expect(html).toMatch(/aria-label="Seek within this song"[^>]*disabled/);
});

test("lost playback grant offers consent even while the local SDK is still ready", () => {
	const p = props();
	p.state = { ...p.state, connection: "ready" };
	const html = renderToStaticMarkup(
		<BrowserPlaybackView
			{...p}
			connection={{
				status: "reconnect_required",
				sdkReady: true,
				controlReady: false,
				reason: "Reconnect playback controls",
			}}
		/>,
	);
	expect(html).toContain("Connect Spotify playback");
	expect(html).not.toContain(">Play this song<");
});

test("grant recovery preserves local pause and mute for confirmed audio", () => {
	const p = props();
	p.state = {
		...p.state,
		connection: "ready",
		actualUri: p.track.spotifyUri,
		selectedUri: p.track.spotifyUri,
		paused: false,
		canPause: true,
	};
	const html = renderToStaticMarkup(
		<BrowserPlaybackView
			{...p}
			connection={{
				status: "reconnect_required",
				sdkReady: true,
				controlReady: false,
				reason: "Reconnect playback controls",
			}}
		/>,
	);
	expect(html).toContain("Connect Spotify playback");
	expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Pause<\/button>/);
	expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Mute<\/button>/);
});
