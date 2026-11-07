import { expect, test } from "bun:test";
import { createLiveApi } from "../data/live-client";
import { liveFixture } from "../test-support/live-fixture";
import { PlayerStore } from "./player";

function setup() {
	const f = liveFixture();
	f.session.capabilities.playback = true;
	const status = {
		available: true,
		deviceId: "device" as string | null,
		isPlaying: false,
		trackUri: null as string | null,
		reason: null as string | null,
	};
	const writes: string[] = [];
	let fail = false;
	let confirm = true;
	const api = createLiveApi({
		fetch: (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/me")) return Response.json(f.session);
			if (url.endsWith("/status")) return Response.json(status);
			if (url.endsWith("/play")) {
				writes.push(String(init?.body));
				if (fail) throw new Error("Response lost");
				if (confirm) {
					status.isPlaying = true;
					status.trackUri = JSON.parse(String(init?.body)).trackUri;
				}
				return Response.json({ ok: true });
			}
			throw new Error("Unexpected route");
		}) as typeof fetch,
	});
	return {
		f,
		api,
		status,
		writes,
		fail: () => {
			fail = true;
		},
		noConfirmation: () => {
			confirm = false;
		},
	};
}
const uri = `spotify:track:${"0".repeat(22)}`;
test("player initialization and status refresh never start audio", async () => {
	const f = setup();
	const player = new PlayerStore(f.api, f.f.session);
	await player.refresh();
	expect(f.writes).toHaveLength(0);
	expect(player.getSnapshot().status?.isPlaying).toBe(false);
});
test("play locks repeated clicks and confirms the actual URI through server status", async () => {
	const f = setup();
	const player = new PlayerStore(f.api, f.f.session);
	await Promise.all([player.play(uri), player.play(uri)]);
	expect(f.writes).toHaveLength(1);
	expect(player.getSnapshot().status?.trackUri).toBe(uri);
	expect(player.getSnapshot().message).toBe("Playing on your Spotify device.");
});
test("no device prevents writes and can recover through an explicit status check", async () => {
	const f = setup();
	f.status.available = false;
	f.status.deviceId = null;
	f.status.reason = "Open Spotify and select a device.";
	const player = new PlayerStore(f.api, f.f.session);
	await player.play(uri);
	expect(f.writes).toHaveLength(0);
	expect(player.getSnapshot().message).toContain("Open Spotify");
	f.status.available = true;
	f.status.deviceId = "new-device";
	await player.refresh();
	await player.play(uri);
	expect(player.getSnapshot().status?.isPlaying).toBe(true);
});
test("accepted play without confirmed audio does not claim playback", async () => {
	const f = setup();
	f.noConfirmation();
	const player = new PlayerStore(f.api, f.f.session);
	await player.play(uri);
	expect(player.getSnapshot().message).toContain("not confirmed");
	expect(player.getSnapshot().status?.isPlaying).toBe(false);
});
test("ambiguous failure never replays itself and status recheck is read-only", async () => {
	const f = setup();
	f.fail();
	const player = new PlayerStore(f.api, f.f.session);
	await player.play(uri);
	await player.refresh();
	expect(f.writes).toHaveLength(1);
	expect(player.getSnapshot().status?.isPlaying).toBe(false);
});
test("capability revocation and account changes prevent playback writes", async () => {
	for (const change of ["capability", "owner"]) {
		const f = setup();
		const player = new PlayerStore(f.api, f.f.session);
		if (change === "owner") f.f.session.user!.id = "other";
		else f.f.session.capabilities.playback = false;
		await player.play(uri);
		expect(f.writes).toHaveLength(0);
		expect(player.getSnapshot().error).not.toBeNull();
	}
});
test("demo and invalid track URIs never reach playback", async () => {
	const f = setup();
	const player = new PlayerStore(f.api, f.f.session);
	await player.play("demo:test");
	expect(f.writes).toHaveLength(0);
	const demo = { ...f.f.session, mode: "demo" as const };
	const isolated = new PlayerStore(f.api, demo);
	await isolated.play(uri);
	expect(f.writes).toHaveLength(0);
});

test("unmount during device lookup cancels a not-yet-submitted playback command", async () => {
	const f = setup();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const api = {
		...f.api,
		playerStatus: async () => {
			await pending;
			return f.status;
		},
	};
	const player = new PlayerStore(api, f.f.session);
	const operation = player.play(uri);
	player.cancel();
	release();
	await operation;
	expect(f.writes).toHaveLength(0);
	expect(player.getSnapshot().busy).toBe(false);
});
