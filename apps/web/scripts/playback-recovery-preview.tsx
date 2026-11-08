// Local regression harness. No provider calls or real credentials. Not a production entry.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserPlayback } from "../src/components/BrowserPlayback";
import { BrowserPlayerStore } from "../src/state/browser-player";
import { liveFixture } from "../src/test-support/live-fixture";
import type { SpotifySdkPlayer } from "../src/data/spotify-sdk";
if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
	throw new Error("Playback regression fixture requires localhost development mode.");
}
let revoked = false;
let reads = 0;
const gateway = {
	authorize: async () => {},
	token: async () => { revoked = true; throw new Error("Fixture expired grant"); },
	play: async () => {},
	connection: async () => {
		reads++;
		return revoked
			? { status: "reconnect_required" as const, sdkReady: false, controlReady: true, reason: "Reconnect streaming permission." }
			: { status: "ready" as const, sdkReady: true, controlReady: true, reason: null };
	},
	connect: async () => { throw new Error("Fixture forbids authorization writes"); },
};
const player = new BrowserPlayerStore(gateway, async (options) => ({
	addListener: () => true,
	removeListener: () => true,
	connect: async () => { options.getOAuthToken(() => {}); return true; },
	disconnect: () => {},
	activateElement: async () => {},
	getCurrentState: async () => null,
	pause: async () => {}, resume: async () => {}, seek: async () => {}, setVolume: async () => {},
} satisfies SpotifySdkPlayer), { volumeSupported: true });
function Harness() {
	const [report, setReport] = useState("");
	return <><h1>LOCAL SYNTHETIC PLAYBACK REGRESSION · no Spotify</h1>
		<BrowserPlayback store={player} gateway={gateway} track={liveFixture().items[0]!.track} returnTo="review" />
		<button type="button" onClick={() => setReport(`Connection reads: ${reads}; grant revoked: ${revoked}`)}>Inspect fixture</button><output>{report}</output>
	</>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
