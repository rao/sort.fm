import { describe, expect, test } from "bun:test";
import { analyticsPath, sanitizePageview } from "./WebAnalytics";

describe("page-view privacy", () => {
	test("hash pages map to fixed paths without forwarding unknown fragments", () => {
		expect(analyticsPath("#/library")).toBe("/library");
		expect(analyticsPath("#/review")).toBe("/review");
		expect(analyticsPath("#/calibrate/research")).toBe("/calibrate/research");
		for (const hash of [
			"",
			"#access_token=private",
			"#/library/private",
			"#/review?trackId=private",
		]) {
			expect(analyticsPath(hash)).toBe("/");
		}
	});

	test("page-view URLs discard credentials, query values and fragments", () => {
		expect(
			sanitizePageview({
				type: "pageview",
				url: "https://user:password@sort.fm/review?code=private&trackId=private#access_token=private",
			}),
		).toEqual({ type: "pageview", url: "https://sort.fm/review" });
		expect(
			sanitizePageview({
				type: "pageview",
				url: "https://sort.fm/private-user-id?label=1",
			}),
		).toEqual({ type: "pageview", url: "https://sort.fm/" });
	});

	test("custom events and malformed URLs are not sent", () => {
		expect(
			sanitizePageview({ type: "event", url: "https://sort.fm/review" }),
		).toBeNull();
		expect(
			sanitizePageview({ type: "pageview", url: "invalid" }),
		).toBeNull();
	});
});
