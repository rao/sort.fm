import { expect, test } from "bun:test";
import { loadLibrary } from "./client";
import { createSyntheticLibrary } from "./data";

test("graph read uses authenticated no-store transport and a typed live-only response", async () => {
	const data = { ...createSyntheticLibrary(1), mode: "live" };
	data.tracks[0]!.id = "a".repeat(22);
	let init: RequestInit | undefined;
	let url = "";
	const result = await loadLibrary({
		signal: new AbortController().signal,
		baseUrl: "https://api.example.test/",
		transport: async (u, i) => {
			url = String(u);
			init = i;
			return Response.json(data);
		},
	});
	expect(result.mode).toBe("live");
	expect(url).toBe("https://api.example.test/api/ml/constellation");
	expect(init).toMatchObject({
		method: "GET",
		cache: "no-store",
		credentials: "include",
		redirect: "error",
	});
});

test("graph errors never use synthetic data or echo server/private response content", async () => {
	for (const status of [401, 403, 404, 500, 503]) {
		const task = loadLibrary({
			signal: new AbortController().signal,
			transport: async () => new Response("private track identity", { status }),
		});
		await expect(task).rejects.not.toThrow("private track identity");
	}
	await expect(
		loadLibrary({
			signal: new AbortController().signal,
			transport: async () => Response.json(createSyntheticLibrary(1)),
		}),
	).rejects.toThrow("could not be verified");
});
