import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { liveFixture } from "../test-support/live-fixture";
import { ReviewStore } from "../state/review";
import { History, HistoryArtwork } from "./History";

test("history displays known title, artist and artwork even without the decision's exposure", async () => {
	const fixture = liveFixture();
	const card = structuredClone(fixture.items[0]!);
	card.track.imageUrl = "https://images.example.test/cover.jpg";
	const store = new ReviewStore(fixture.client);
	await store.load();
	await store.decide("KEEP");
	const snapshot = store.getSnapshot();
	const state = {
		...snapshot,
		queue: [card],
		history: snapshot.history.map((entry) => ({ ...entry, item: null })),
	};
	const html = renderToStaticMarkup(
		<History state={state} onUndo={() => {}} />,
	);
	expect(html).toContain(card.track.title);
	expect(html).toContain(card.track.artists[0]!.name);
	expect(html).toContain('src="https://images.example.test/cover.jpg"');
	expect(html).toContain("decision-tag keep");
	expect(state.history[0]!.item).toBeNull();
});

test("unresolved history stays readable without pretending an ID is a song name or supplying invented art", async () => {
	const fixture = liveFixture();
	const store = new ReviewStore(fixture.client);
	await store.load();
	await store.decide("SKIP");
	const snapshot = store.getSnapshot();
	const state = {
		...snapshot,
		queue: [],
		history: snapshot.history.map((entry) => ({ ...entry, item: null })),
	};
	const html = renderToStaticMarkup(
		<History state={state} onUndo={() => {}} />,
	);
	const text = html.replace(/<[^>]*>/g, " ");
	expect(text).toContain("Song details unavailable");
	expect(text).not.toContain(state.history[0]!.result.trackId);
	expect(html).toContain("Album artwork unavailable");
	expect(html).toContain(
		`https://open.spotify.com/track/${state.history[0]!.result.trackId}`,
	);
	expect(html).toContain("decision-tag skip");
	expect(html).not.toContain("<img");
});

test("resolved historical artwork uses the actual URL and missing artwork remains explicit", () => {
	const track = {
		id: "a".repeat(22),
		title: "Known song",
		artist: "Known artist",
		imageUrl: "https://images.example.test/album.jpg",
	};
	expect(renderToStaticMarkup(<HistoryArtwork track={track} />)).toContain(
		'src="https://images.example.test/album.jpg"',
	);
	const missing = renderToStaticMarkup(
		<HistoryArtwork track={{ ...track, imageUrl: null }} />,
	);
	expect(missing).toContain("Album artwork unavailable");
	expect(missing).not.toContain("<img");
});
