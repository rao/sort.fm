import { expect, test } from "bun:test";
import { BrowserPlayerStore } from "./browser-player";
import type {
	SpotifySdkEvents,
	SpotifySdkOptions,
	SpotifySdkPlayer,
	SpotifyPlaybackState,
} from "../data/spotify-sdk";

function fixture(extra: { operationTimeoutMs?: number } = {}) {
	const calls: string[] = [];
	const events = new Map<string, (value: never) => void>();
	let options!: SpotifySdkOptions;
	let owner = true;
	let playback: SpotifyPlaybackState | null = null;
	const player: SpotifySdkPlayer = {
		addListener(name, callback) {
			events.set(name, callback as (value: never) => void);
			return true;
		},
		removeListener(name) {
			events.delete(name);
			return true;
		},
		async connect() {
			calls.push("connect");
			emit("ready", { device_id: "browser-device" });
			return true;
		},
		disconnect() {
			calls.push("disconnect");
		},
		async activateElement() {
			calls.push("activate");
		},
		async getCurrentState() {
			return playback;
		},
		async pause() {
			calls.push("pause");
			if (playback) playback = { ...playback, paused: true };
		},
		async resume() {
			calls.push("resume");
			if (playback) playback = { ...playback, paused: false };
		},
		async seek(position) {
			calls.push(`seek:${position}`);
			if (playback) playback = { ...playback, position };
		},
		async setVolume(volume) {
			calls.push(`volume:${volume}`);
		},
	};
	function emit<K extends keyof SpotifySdkEvents>(
		name: K,
		value: SpotifySdkEvents[K],
	) {
		if (name === "player_state_changed")
			playback = value as SpotifyPlaybackState | null;
		events.get(name)?.(value as never);
	}
	function confirm(uri: string) {
		playback = {
			paused: false,
			position: 1000,
			duration: 200000,
			track_window: { current_track: { uri } },
			disallows: {},
		};
		emit("player_state_changed", playback);
	}
	const gateway = {
		async authorize() {
			calls.push("authorize");
			if (!owner) throw new Error("Account changed");
		},
		async token() {
			calls.push("token");
			if (!owner) throw new Error("Account changed");
			return "test-sdk-only-token";
		},
		async play(uri: string, device: string) {
			calls.push(`play:${uri}:${device}`);
		},
	};
	const store = new BrowserPlayerStore(
		gateway,
		async (value) => {
			options = value;
			return player;
		},
		{ volumeSupported: true, ...extra },
	);
	return {
		store,
		gateway,
		calls,
		player,
		emit,
		confirm,
		changeOwner: () => {
			owner = false;
		},
		options: () => options,
	};
}
const uri = `spotify:track:${"0".repeat(22)}`;
const next = `spotify:track:${"1".repeat(22)}`;

test("selection never plays until a user gesture and only matching SDK state confirms audio", async () => {
	const f = fixture();
	f.store.select(uri, true);
	expect(f.calls).toEqual([]);
	await f.store.enable();
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
	await f.store.play();
	expect(f.calls).toContain(`play:${uri}:browser-device`);
	expect(f.store.getSnapshot().actualUri).toBeNull();
	f.confirm(uri);
	expect(f.store.getSnapshot().actualUri).toBe(uri);
	expect(f.store.getSnapshot().paused).toBe(false);
});
test("seek, pause and mute are playback-only and obey track identity", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.confirm(uri);
	await f.store.seek(90000);
	await f.store.togglePause();
	await f.store.toggleMute();
	expect(f.calls).toContain("seek:90000");
	expect(f.calls).toContain("pause");
	expect(f.calls).toContain("volume:0");
	await f.store.toggleMute();
	expect(f.store.getSnapshot().volume).toBe(0.6);
	f.store.select(next, true);
	await f.store.seek(5000);
	expect(f.calls).not.toContain("seek:5000");
});
test("card change fences an in-flight play before it reaches the backend", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	let release!: () => void;
	f.gateway.authorize = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	const action = f.store.play();
	f.store.select(next, true);
	release();
	await action;
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
});
test("owner failure disconnects and cannot send playback", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.changeOwner();
	await f.store.play();
	expect(f.calls).toContain("disconnect");
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
	expect(f.store.getSnapshot().connection).toBe("error");
});
test("device loss disables controls and SDK errors never expose raw messages", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.emit("not_ready", { device_id: "browser-device" });
	await f.store.play();
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
	f.emit("authentication_error", { message: "secret-provider-details" });
	expect(JSON.stringify(f.store.getSnapshot())).not.toContain(
		"secret-provider-details",
	);
});
test("token renewal uses fresh authorization and disposal fences callbacks", async () => {
	const f = fixture();
	await f.store.enable();
	const received: string[] = [];
	f.options().getOAuthToken((value) => received.push(value));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(received).toEqual(["test-sdk-only-token"]);
	f.store.dispose();
	f.options().getOAuthToken((value) => received.push(value));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(received).toHaveLength(1);
	expect(JSON.stringify(f.store.getSnapshot())).not.toContain(
		"test-sdk-only-token",
	);
});

test("automatic card playback is opt-in and never starts before initial play", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.store.setAutoAdvance(true);
	f.store.select(next, true);
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
	await f.store.play();
	f.confirm(next);
	f.store.select(uri, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.filter((c) => c.startsWith("play:"))).toEqual([
		`play:${next}:browser-device`,
		`play:${uri}:browser-device`,
	]);
});
test("late backend acceptance of an old card is paused without labeling or replay", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	let release!: () => void;
	f.gateway.play = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	const action = f.store.play();
	await new Promise((resolve) => setTimeout(resolve, 0));
	f.store.select(next, true);
	release();
	await action;
	expect(f.calls).toContain("pause");
	expect(f.store.getSnapshot().selectedUri).toBe(next);
});
test("unplayable selections, missing SDK ready and refused controls fail honestly", async () => {
	const f = fixture();
	f.store.select(uri, false);
	await f.store.enable();
	await f.store.play();
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(0);
	f.store.select(uri, true);
	f.confirm(uri);
	f.emit("player_state_changed", {
		paused: false,
		position: 100,
		duration: 200000,
		track_window: { current_track: { uri } },
		disallows: { seeking: true, pausing: true },
	});
	await f.store.seek(3000);
	await f.store.togglePause();
	expect(f.calls).not.toContain("seek:3000");
	expect(f.calls).not.toContain("pause");
});
test("repeated play clicks issue one target request", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	await Promise.all([f.store.play(), f.store.play(), f.store.play()]);
	expect(f.calls.filter((c) => c.startsWith("play:"))).toHaveLength(1);
});

test("an autoplay failure cannot unlock an unresolved play request", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	let release!: () => void;
	let attempts = 0;
	f.gateway.play = () => {
		attempts++;
		return new Promise<void>((resolve) => {
			release = resolve;
		});
	};
	const first = f.store.play();
	await new Promise((resolve) => setTimeout(resolve, 0));
	f.emit("autoplay_failed", undefined);
	expect(f.store.getSnapshot().busy).toBe(true);
	const second = f.store.play();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(attempts).toBe(1);
	release();
	await Promise.all([first, second]);
});

test.each(["resume", "seek"] as const)(
	"%s cannot target a different SDK song after authorization",
	async (control) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.confirm(uri);
		if (control === "resume") await f.store.togglePause();
		f.calls.length = 0;
		let release!: () => void;
		f.gateway.authorize = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const action =
			control === "resume" ? f.store.togglePause() : f.store.seek(90000);
		f.confirm(next);
		release();
		await action;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.calls).not.toContain(
			control === "resume" ? "resume" : "seek:90000",
		);
		expect(f.store.getSnapshot().paused).toBe(true);
	},
);

test.each(["resume", "pause", "seek"] as const)(
	"%s obeys disallows updated during authorization",
	async (control) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.confirm(uri);
		if (control === "resume") await f.store.togglePause();
		f.calls.length = 0;
		let release!: () => void;
		f.gateway.authorize = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const action =
			control === "seek" ? f.store.seek(90000) : f.store.togglePause();
		f.emit("player_state_changed", {
			paused: control === "resume",
			position: 1000,
			duration: 200000,
			track_window: { current_track: { uri } },
			disallows: { seeking: true, pausing: true, resuming: true },
		});
		release();
		await action;
		expect(f.calls).not.toContain(control === "seek" ? "seek:90000" : control);
	},
);

test("opting out during automatic playback authorization cancels the target request", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	await f.store.play();
	f.confirm(uri);
	f.store.setAutoAdvance(true);
	let release!: () => void;
	f.gateway.authorize = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	f.store.select(next, true);
	f.store.setAutoAdvance(false);
	release();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.filter((call) => call.startsWith("play:"))).toEqual([
		`play:${uri}:browser-device`,
	]);
});

test("stale authorization rejection cannot disconnect a newly connected player", async () => {
	const f = fixture();
	await f.store.enable();
	let reject!: (error: Error) => void;
	f.gateway.authorize = () =>
		new Promise<void>((_resolve, no) => {
			reject = no;
		});
	const refresh = f.store.refresh();
	f.emit("not_ready", { device_id: "browser-device" });
	f.gateway.authorize = async () => {};
	await f.store.enable();
	reject(new Error("Old account check failed"));
	await refresh;
	expect(f.store.getSnapshot().connection).toBe("ready");
	f.store.dispose();
});
test("a hanging pause during card change disconnects instead of locking controls indefinitely", async () => {
	const f = fixture({ operationTimeoutMs: 5 });
	await f.store.enable();
	f.store.select(uri, true);
	f.confirm(uri);
	f.player.pause = () => new Promise<void>(() => {});
	f.store.select(next, true);
	await new Promise((resolve) => setTimeout(resolve, 15));
	expect(f.store.getSnapshot().busy).toBe(false);
	expect(f.store.getSnapshot().connection).toBe("error");
});
test("a hanging pause after stale backend acceptance is bounded", async () => {
	const f = fixture({ operationTimeoutMs: 20 });
	await f.store.enable();
	f.store.select(uri, true);
	let release!: () => void;
	f.gateway.play = () =>
		new Promise<void>((resolve) => {
			release = resolve;
		});
	f.player.pause = () => new Promise<void>(() => {});
	const action = f.store.play();
	await new Promise((resolve) => setTimeout(resolve, 0));
	f.store.select(next, true);
	release();
	await action;
	expect(f.store.getSnapshot().busy).toBe(false);
	expect(f.store.getSnapshot().connection).toBe("error");
});

test("late polling cannot overwrite a newer song event or pause that song", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	let resolve!: (value: SpotifyPlaybackState | null) => void;
	f.player.getCurrentState = () =>
		new Promise((r) => {
			resolve = r;
		});
	const pending = f.store.refresh();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	f.store.select(next, true);
	f.confirm(next);
	resolve({
		paused: false,
		position: 1,
		duration: 200000,
		track_window: { current_track: { uri } },
	});
	await pending;
	expect(f.store.getSnapshot().actualUri).toBe(next);
	expect(f.store.getSnapshot().paused).toBe(false);
	expect(f.calls).not.toContain("pause");
	f.store.dispose();
});
test("StrictMode release and retain preserves the active player; real unmount disconnects", async () => {
	const f = fixture();
	const release = f.store.retain();
	await f.store.enable();
	release();
	const releaseAgain = f.store.retain();
	await Promise.resolve();
	expect(f.store.getSnapshot().connection).toBe("ready");
	releaseAgain();
	await Promise.resolve();
	expect(f.calls).toContain("disconnect");
});

test.each(["selection", "dispose"])(
	"pending resume activation cannot play after %s changes",
	async (change) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.confirm(uri);
		await f.store.togglePause();
		let release!: () => void;
		f.player.activateElement = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const action = f.store.togglePause();
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (change === "selection") f.store.select(next, true);
		else f.store.dispose();
		release();
		await action;
		expect(f.calls).not.toContain("resume");
		f.store.dispose();
	},
);
