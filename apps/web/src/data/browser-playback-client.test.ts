import { expect, spyOn, test } from "bun:test";
import { PLAYBACK_SDK_SCOPES } from "@sortfm/contracts";
import { createLiveApi } from "./live-client";
import { createBrowserPlaybackClient } from "./browser-playback-client";
import { liveFixture } from "../test-support/live-fixture";
function fixture() {
	const session = structuredClone(liveFixture().session);
	const calls: { url: string; init?: RequestInit }[] = [];
	const token = {
		ownerId: session.user!.id,
		accessToken: "fake-sdk-credential",
		tokenType: "Bearer",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		scopes: [...PLAYBACK_SDK_SCOPES] as string[],
	};
	let fail = false;
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			const value = url.endsWith("/api/me")
				? session
				: url.endsWith("/token")
					? token
					: url.endsWith("/connection")
						? {
								status: "ready",
								sdkReady: true,
								controlReady: true,
								reason: null,
							}
						: url.endsWith("/connect")
							? {
									authorizationUrl:
										"https://accounts.spotify.com/authorize?response_type=code&state=fixture",
								}
							: { ok: true };
			if (fail && url.endsWith("/sdk/play"))
				return Response.json(
					{
						code: "PLAYBACK_OUTCOME_UNKNOWN",
						message: "unknown",
						retryable: false,
					},
					{ status: 503 },
				);
			return Response.json(value);
		}) as typeof fetch,
	});
	return {
		api,
		client: createBrowserPlaybackClient(api, session),
		session,
		token,
		calls,
		fail: () => {
			fail = true;
		},
	};
}
test("playback works independently of legacy library capabilities and uses backend exact-device play", async () => {
	const f = fixture();
	f.session.capabilities = {
		spotifyRead: false,
		spotifyWrite: false,
		playback: false,
	};
	expect((await f.client.connection()).status).toBe("ready");
	await f.client.play(`spotify:track:${"0".repeat(22)}`, "device");
	expect(f.calls.find((c) => c.url.endsWith("/sdk/play"))?.init?.body).toBe(
		JSON.stringify({
			trackUri: `spotify:track:${"0".repeat(22)}`,
			deviceId: "device",
		}),
	);
	expect(f.calls.every((c) => c.init?.credentials === "include")).toBe(true);
	expect(
		f.calls.some((c) => /decisions|calibration|library|transfer/.test(c.url)),
	).toBe(false);
});
test("SDK credential uses no-store and owner/scope/expiry validation", async () => {
	const f = fixture();
	expect(await f.client.token()).toBe("fake-sdk-credential");
	const request = f.calls.find((c) => c.url.endsWith("/token"))!.init!;
	expect(request.cache).toBe("no-store");
	expect(request.redirect).toBe("error");
	f.token.scopes.push("user-library-modify");
	await expect(f.client.token()).rejects.toThrow();
	f.token.scopes = [...PLAYBACK_SDK_SCOPES];
	f.token.ownerId = "other";
	await expect(f.client.token()).rejects.toThrow();
	f.token.ownerId = "owner";
	f.token.expiresAt = new Date(0).toISOString();
	await expect(f.client.token()).rejects.toThrow();
});
test("changed owner cannot issue playback and uncertain requests are not retried", async () => {
	const f = fixture();
	f.fail();
	await expect(
		f.client.play(`spotify:track:${"0".repeat(22)}`, "device"),
	).rejects.toThrow();
	expect(f.calls.filter((c) => c.url.endsWith("/sdk/play"))).toHaveLength(1);
	f.session.user!.id = "other";
	await expect(
		f.client.play(`spotify:track:${"0".repeat(22)}`, "device"),
	).rejects.toThrow("account changed");
	expect(f.calls.filter((c) => c.url.endsWith("/sdk/play"))).toHaveLength(1);
});
test("calibration consent preserves its return destination", async () => {
	const f = fixture();
	expect(await f.client.connect("calibration")).toContain(
		"https://accounts.spotify.com/authorize",
	);
	expect(f.calls.find((c) => c.url.endsWith("/connect"))?.init?.body).toBe(
		'{"returnTo":"calibration"}',
	);
});

test("a token that expires during the final owner check is never returned to the SDK", async () => {
	const f = fixture();
	let checks = 0;
	const clock = spyOn(Date, "now");
	const api = {
		...f.api,
		session: async () => {
			if (++checks === 2)
				clock.mockReturnValue(Date.parse(f.token.expiresAt) + 1);
			return f.session;
		},
	};
	const client = createBrowserPlaybackClient(api, f.session);
	try {
		await expect(client.token()).rejects.toThrow("expired");
	} finally {
		clock.mockRestore();
	}
});

test("a selection invalidated during the adapter owner check never submits play", async () => {
	const f = fixture();
	let current = true;
	const client = createBrowserPlaybackClient(
		{
			...f.api,
			session: async () => {
				current = false;
				return f.session;
			},
		},
		f.session,
	);
	await client.play(`spotify:track:${"0".repeat(22)}`, "device", () => current);
	expect(f.calls.filter((call) => call.url.endsWith("/sdk/play"))).toHaveLength(
		0,
	);
});
