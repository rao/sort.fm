import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoBootstrap } from "@sortfm/contracts/fixtures";
import { MusicDeskChrome } from "./MusicDesk";
import { ReviewPlayer, ReviewUndo } from "./ReviewPlayer";
import { ReviewStore } from "../state/review";
import { liveFixture } from "../test-support/live-fixture";

const controls = {
	night: false,
	playbackVisible: false,
	onNight: () => {},
	onPlayback: () => {},
	onAccount: () => {},
};

test("connected chrome keeps account and server counts distinct from the demo", () => {
	const f = liveFixture();
	const html = renderToStaticMarkup(
		<MusicDeskChrome
			{...controls}
			route="review"
			session={f.client.live!.session}
			total={2700}
			remaining={null}
		/>,
	);
	expect(html).toContain("Listener");
	expect(html).toContain("Spotify connected");
	expect(html).toContain("2,700");
	expect(html).toContain("Remaining unavailable");
	expect(html).not.toContain("Demo listener");
	expect(html).not.toContain("0 remaining");
});

test("model and collection subroutes remain reachable and correctly grouped", () => {
	const model = renderToStaticMarkup(
		<MusicDeskChrome
			{...controls}
			route="insights"
			session={demoBootstrap.session}
			total={12}
			remaining={12}
		/>,
	);
	expect(model).toContain('href="#/model" aria-current="page"');
	expect(model).toContain('href="#/insights" aria-current="page"');
	expect(model).toContain("Inspector");
	expect(model).toContain("Demo listener");
	const library = renderToStaticMarkup(
		<MusicDeskChrome
			{...controls}
			route="library"
			session={demoBootstrap.session}
			total={12}
			remaining={12}
		/>,
	);
	expect(library).toContain('href="#/dashboard" aria-current="page"');
	expect(library).toContain('href="#/library" aria-current="page"');
});

async function playerState() {
	const f = liveFixture();
	const store = new ReviewStore(f.client);
	await store.load();
	return { f, store, state: store.getSnapshot() };
}
const playerControls = {
	onAction: () => {},
	onUndo: () => {},
	onDetails: () => {},
	onListen: () => {},
	onShortcuts: () => {},
	showDetails: true,
};

test("real review device displays Spotify metadata without fictional artwork substitution", async () => {
	const { state } = await playerState();
	state.queue[0]!.track.title = "Actual saved song";
	state.queue[0]!.track.album = "Actual album";
	state.queue[0]!.track.artists = [{ name: "Actual artist", id: null }];
	state.queue[0]!.track.imageUrl = "https://i.scdn.co/image/example";
	const html = renderToStaticMarkup(
		<ReviewPlayer {...playerControls} state={state} canRemove />,
	);
	expect(html).toContain("Actual saved song");
	expect(html).toContain("Actual artist");
	expect(html).toContain("https://i.scdn.co/image/example");
	expect(html).toContain('dateTime="2020-01-07T00:00:00.000Z"');
	expect(html).not.toContain("Original demo artwork");
	expect(html).toContain(
		"Archive keeps a playlist copy before unliking. Unlike removes directly.",
	);
	expect(html).toMatch(/aria-label="Undo latest decision"[^>]*disabled/);
});

test("device enforces read-only capability and freezes all decisions during recovery", async () => {
	const { state } = await playerState();
	const readOnly = renderToStaticMarkup(
		<ReviewPlayer {...playerControls} state={state} canRemove={false} />,
	);
	for (const action of ["Archive", "Unlike"])
		expect(readOnly).toMatch(
			new RegExp(`aria-label="${action} song[^>]+disabled`),
		);
	expect(readOnly).not.toMatch(/aria-label="Keep song[^>]+disabled/);
	const locked = renderToStaticMarkup(
		<ReviewPlayer
			{...playerControls}
			state={{ ...state, refreshError: "Queue unavailable" }}
			canRemove
		/>,
	);
	for (const action of ["Archive", "Unlike", "Skip", "Keep"])
		expect(locked).toMatch(
			new RegExp(`aria-label="${action} song[^>]+disabled`),
		);
});

test("persistent Undo follows authoritative canUndo and pending-command locks", async () => {
	const { store } = await playerState();
	await store.decide("KEEP");
	const state = store.getSnapshot();
	const ready = renderToStaticMarkup(
		<ReviewPlayer {...playerControls} state={state} canRemove />,
	);
	expect(ready).not.toMatch(/aria-label="Undo latest decision"[^>]*disabled/);
	const busy = renderToStaticMarkup(
		<ReviewPlayer
			{...playerControls}
			state={{ ...state, retraining: true }}
			canRemove
		/>,
	);
	expect(busy).toMatch(/aria-label="Undo latest decision"[^>]*disabled/);
});

test("Undo remains available on an exhausted queue and locks during refresh", async () => {
	const { store } = await playerState();
	await store.decide("KEEP");
	const state = { ...store.getSnapshot(), queue: [] };
	const ready = renderToStaticMarkup(
		<ReviewUndo state={state} onUndo={() => {}} />,
	);
	expect(ready).toContain("Undo latest decision");
	expect(ready).not.toMatch(/aria-label="Undo latest decision"[^>]*disabled/);
	const busy = renderToStaticMarkup(
		<ReviewUndo state={{ ...state, refreshing: true }} onUndo={() => {}} />,
	);
	expect(busy).toMatch(/aria-label="Undo latest decision"[^>]*disabled/);
});
