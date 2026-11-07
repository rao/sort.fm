import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoBootstrap } from "@sortfm/contracts/fixtures";
import { Library } from "./components/Library";
import { ModelPanel, PredictionDisplay } from "./components/ModelPanel";
import { SwipeCard, ActionButtons } from "./components/SwipeCard";
import { ReviewStore } from "./state/review";
import { createDemoClient } from "./data/demo-client";
import { Landing } from "./components/Landing";

describe("frontend contract rendering", () => {
	test("landing offers demo without requiring a Spotify account", () => {
		const html = renderToStaticMarkup(<Landing onConnect={() => {}} />);
		expect(html).toContain("Try demo");
		expect(html).toContain("No Spotify account needed");
	});
	test("song card preserves synthetic provenance and saved date", () => {
		const html = renderToStaticMarkup(
			<SwipeCard
				item={demoBootstrap.queue.items[0]!}
				busy={false}
				departure={null}
				onAction={() => {}}
			/>,
		);
		expect(html).toContain("After the Rain");
		expect(html).toContain("Paper Satellites");
		expect(html).toContain('dateTime="2020-01-07T00:00:00.000Z"');
		expect(html).toContain("Original demo artwork");
		expect(html).not.toContain("spotify:track:");
	});
	test("null prediction shows unavailable instead of zero percent", () => {
		const html = renderToStaticMarkup(
			<PredictionDisplay
				prediction={demoBootstrap.queue.items[0]!.prediction}
			/>,
		);
		expect(html).toContain("Prediction unavailable");
		expect(html).not.toMatch(/\d+(?:\.\d+)?%/);
	});
	test("model panel explicitly identifies the untrained model", () => {
		const html = renderToStaticMarkup(
			<ModelPanel
				prediction={null}
				labeled={0}
				total={12}
				metrics={demoBootstrap.metrics}
			/>,
		);
		expect(html).toContain("Model not trained");
		expect(html).toContain("untrained-v0");
		expect(html).toContain("No personalized ranking");
	});
	test("empty library provides recovery without a calibration CTA", async () => {
		const store = new ReviewStore(
			createDemoClient({ latency: 0, scenario: "empty" }),
		);
		await store.load();
		const html = renderToStaticMarkup(
			<Library state={store.getSnapshot()} onRetry={() => {}} />,
		);
		expect(html).toContain("A clean slate");
		expect(html).not.toContain('href="#/calibrate"');
	});
	test("every decision button is disabled while a command is in flight", () => {
		const html = renderToStaticMarkup(
			<ActionButtons disabled onAction={() => {}} />,
		);
		expect(html.match(/disabled=""/g)).toHaveLength(4);
	});
});

test("missing live metrics never claims zero training or a partial history total", () => {
	const html = renderToStaticMarkup(
		<ModelPanel
			prediction={null}
			metrics={null}
			labeled={null}
			total={20}
			live
		/>,
	);
	expect(html).toContain("Metrics unavailable");
	expect(html).toContain("Unavailable");
	expect(html).not.toContain("Model not trained");
});

test("read-only Spotify sessions disable destructive action buttons", () => {
	const html = renderToStaticMarkup(
		<ActionButtons disabled={false} canRemove={false} onAction={() => {}} />,
	);
	expect(html.match(/disabled=""/g)).toHaveLength(2);
});
