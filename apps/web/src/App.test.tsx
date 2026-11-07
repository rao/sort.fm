import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { demoBootstrap } from "@sortfm/contracts/fixtures";
import { DemoContent } from "./App";

describe("foundation demo rendering", () => {
  test("keeps synthetic provenance and the original saved timestamp visible", () => {
    const html = renderToStaticMarkup(<DemoContent {...demoBootstrap} />);

    expect(html).toContain("Synthetic demo");
    expect(html).toContain("Synthetic track");
    expect(html).toContain("After the Rain");
    expect(html).toContain("Paper Satellites");
    expect(html).toContain('dateTime="2020-01-07T00:00:00.000Z"');
    expect(html).not.toContain("spotify:track:");
  });

  test("shows unavailable evaluation rather than converting null metrics to zero", () => {
    const html = renderToStaticMarkup(<DemoContent {...demoBootstrap} />);

    expect(html).toContain("Evaluation unavailable");
    expect(html).toContain("No labeled feedback");
    expect(html).not.toMatch(/\d+(?:\.\d+)?%/);
  });

  test("gives an empty queue an explicit state", () => {
    const html = renderToStaticMarkup(
      <DemoContent {...demoBootstrap} queue={{ ...demoBootstrap.queue, items: [], remaining: 0 }} />,
    );

    expect(html).toContain("No demo tracks are available");
    expect(html).not.toContain("After the Rain");
  });
});
