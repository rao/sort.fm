import catalog from "../apps/web/src/data/demo-catalog.json";

// Read-only availability check. Never downloads or stores the recordings.
let failures = 0;
for (let start = 0; start < catalog.length; start += 4) {
	await Promise.all(catalog.slice(start, start + 4).map(async (song) => {
		try {
			const response = await fetch(song.previewUrl, {
				method: "HEAD",
				signal: AbortSignal.timeout(15_000),
			});
			const type = response.headers.get("content-type") ?? "";
			if (!response.ok || !/audio|mpeg|mp4|octet-stream/i.test(type)) {
				throw new Error(`HTTP ${response.status}, ${type}`);
			}
			console.log(`OK ${song.artist} — ${song.title}`);
		} catch (error) {
			failures++;
			console.error(`FAIL ${song.artist} — ${song.title}: ${String(error)}`);
		}
	}));
}
console.log(`${catalog.length - failures}/${catalog.length} audio previews reachable.`);
if (failures) process.exitCode = 1;
