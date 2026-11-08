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
test("idle browser player keeps a manual readiness fallback and does not offer library mutations", () => {
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
test("only explicit linked identity enables selected-song controls for a different actual URI", () => {
	const p = props();
	p.state = {
		...p.state,
		connection: "ready",
		actualUri: `spotify:track:${"2".repeat(22)}`,
		actualLinkedFromUri: p.track.spotifyUri,
		selectedUri: p.track.spotifyUri,
		paused: false,
		canPause: true,
		canSeek: true,
		durationMs: 200000,
	};
	const linked = renderToStaticMarkup(<BrowserPlaybackView {...p} />);
	expect(linked).toMatch(/<button(?![^>]*disabled)[^>]*>Pause<\/button>/);
	expect(linked).not.toMatch(/aria-label="Seek within this song"[^>]*disabled/);
	const unmatched = renderToStaticMarkup(
		<BrowserPlaybackView
			{...p}
			state={{ ...p.state, actualLinkedFromUri: null }}
		/>,
	);
	expect(unmatched).not.toContain(">Pause<");
	expect(unmatched).toContain("Play this song");
	expect(unmatched).toMatch(/aria-label="Seek within this song"[^>]*disabled/);
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

test("compact player keeps setup controls discoverable and errors outside collapsed options", () => {
	const p = props();
	const idle = renderToStaticMarkup(<BrowserPlaybackView {...p} />);
	expect(idle).toContain("Getting browser playback ready");
	const html = renderToStaticMarkup(
		<BrowserPlaybackView {...p} error="Playback needs attention" />,
	);
	const settings = html.match(
		/<details class="browser-player-settings"[\s\S]*?<\/details>/,
	)?.[0];
	expect(settings).toBeDefined();
	expect(settings).not.toMatch(/^<details[^>]*\bopen/);
	for (const label of [
		"Player options",
		"Playback volume",
		"Play each new song",
	])
		expect(settings).toContain(label);
	expect(settings).not.toContain("Playback needs attention");
	expect(settings).not.toContain("Check connection");
	expect(html).toContain("Check connection");
	expect(html).toContain("Playback needs attention");
	expect(html).toContain("Enable browser player");
});

test("missing grants explain both consent stages outside Options and replace stale SDK errors", () => {
	const p = props();
	for (const sdkReady of [false, true]) {
		const html = renderToStaticMarkup(
			<BrowserPlaybackView
				{...p}
				state={{ ...p.state, connection: "error", error: "Old player error" }}
				connection={{
					status: "reconnect_required",
					sdkReady,
					controlReady: false,
					reason: "Connect the remaining playback permissions.",
				}}
			/>,
		);
		const output = html.match(
			/<output class="browser-player-message"[^>]*>(.*?)<\/output>/,
		)?.[1];
		expect(output).toContain(sdkReady ? "Step 2 of 2" : "Step 1 of 2");
		expect(output).toContain(
			sdkReady ? "playback controls" : "browser streaming",
		);
		expect(output).not.toContain("Old player error");
		expect(html).toContain("Connect Spotify playback");
		expect(html).not.toContain(">Reconnect player<");
	}
});

test("device failure remains visible when both grants are valid; healthy playback stays compact", () => {
	const p = props();
	const failed = renderToStaticMarkup(
		<BrowserPlaybackView
			{...p}
			state={{
				...p.state,
				connection: "error",
				error: "This browser cannot initialize protected Spotify playback.",
			}}
		/>,
	);
	expect(failed).toContain("Reconnect player");
	expect(failed).toContain("Check connection");
	expect(failed).toMatch(
		/<output[^>]*>This browser cannot initialize protected Spotify playback\.<\/output>/,
	);
	expect(failed).not.toContain("Step 1 of 2");
	const ready = renderToStaticMarkup(
		<BrowserPlaybackView {...p} state={{ ...p.state, connection: "ready" }} />,
	);
	expect(ready).not.toContain("Check connection");
	expect(ready).toContain(
		'<output class="browser-player-message" aria-live="polite"></output>',
	);
});
