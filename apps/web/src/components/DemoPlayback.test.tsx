import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DemoPlayback } from "./DemoPlayback";
import { demoTracks, demoPreview } from "../data/demo-catalog";

test("every demo track renders its own real preview with controls and provider link", () => {
	for (const track of demoTracks) {
		const preview = demoPreview(track.trackId)!;
		const html = renderToStaticMarkup(<DemoPlayback track={track} />);
		expect(html).toContain("<audio");
		expect(html).not.toContain('controls=""');
		expect(html).toContain('aria-label="Play preview"');
		expect(html).toContain('aria-label="Seek preview"');
		expect(html).toContain('role="switch"');
		expect(html).not.toContain("Preview provided courtesy");
		expect(html).toContain('preload="none"');
		expect(html).toContain(preview.previewUrl);
		expect(html).toContain(preview.storeUrl.replaceAll("&", "&amp;"));
		expect(html).not.toContain("autoPlay");
	}
});

test("unknown tracks cannot borrow another song's audio", () => {
	const html = renderToStaticMarkup(
		<DemoPlayback track={{ ...demoTracks[0]!, trackId: "demo:unknown" }} />,
	);
	expect(html).not.toContain("<audio");
	expect(html).toContain("Preview unavailable");
});
