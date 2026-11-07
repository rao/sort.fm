import { expect, test } from "bun:test";
import { createLiveApi } from "./live-client";
import { demoBootstrap } from "@sortfm/contracts/fixtures";

const uri = `spotify:track:${"0".repeat(22)}`;
test("playback and retrain use the frozen credentialed routes, validated bodies and responses", async () => {
	const calls: { url: string; init?: RequestInit }[] = [];
	const api = createLiveApi({
		baseUrl: "https://api.example.test/",
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			if (String(input).endsWith("/status"))
				return Response.json({
					available: true,
					deviceId: "device",
					isPlaying: false,
					trackUri: null,
					reason: null,
				});
			if (String(input).endsWith("/retrain"))
				return Response.json({
					userId: "owner",
					modelVersion: "untrained-v0",
					featureVersion: "sortfm.features.v1",
					feedbackRevision: 0,
					trainedExamples: 0,
					metrics: demoBootstrap.metrics,
				});
			return Response.json({ ok: true });
		}) as unknown as typeof fetch,
	});
	expect((await api.playerStatus()).deviceId).toBe("device");
	await api.play(uri);
	expect((await api.retrain()).feedbackRevision).toBe(0);
	expect(
		calls.map((c) => [c.url, c.init?.method, c.init?.credentials]),
	).toEqual([
		["https://api.example.test/api/player/status", "GET", "include"],
		["https://api.example.test/api/player/play", "POST", "include"],
		["https://api.example.test/api/ml/retrain", "POST", "include"],
	]);
	expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ trackUri: uri });
	expect(calls[2]?.init?.body).toBeUndefined();
	await expect(api.play("demo:track")).rejects.toThrow();
	expect(calls).toHaveLength(3);
});
test("play and retrain never automatically retry an ambiguous POST", async () => {
	let attempts = 0;
	const api = createLiveApi({
		fetch: (async () => {
			attempts++;
			return Response.json(
				{ code: "OFFLINE", message: "Outcome unknown", retryable: true },
				{ status: 503 },
			);
		}) as unknown as typeof fetch,
	});
	await expect(api.play(uri)).rejects.toThrow("Outcome unknown");
	await expect(api.retrain()).rejects.toThrow("Outcome unknown");
	expect(attempts).toBe(2);
});
test("malformed playback success cannot become a playing state", async () => {
	const api = createLiveApi({
		fetch: (async () =>
			Response.json({ ok: false })) as unknown as typeof fetch,
	});
	await expect(api.play(uri)).rejects.toThrow("shared contract");
	await expect(api.playerStatus()).rejects.toThrow("shared contract");
});
