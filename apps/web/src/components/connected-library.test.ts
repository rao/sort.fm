import { expect, test } from "bun:test";
import { loadLibraryOverview } from "./Connected";
import { liveFixture } from "../test-support/live-fixture";

test("an unavailable import status does not hide a readable saved library", async () => {
	const f = liveFixture();
	const result = await loadLibraryOverview(f.api);
	expect(result.summary?.total).toBe(2700);
	expect(result.summary?.remaining).toBe(2);
	expect(result.status).toBeNull();
	expect(result.error).toContain("Unavailable");
});
