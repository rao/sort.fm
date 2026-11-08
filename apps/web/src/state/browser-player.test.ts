import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
test.each(["read", "event"] as const)(
	"delayed previous-track %s cannot stop an explicitly requested song on the same card",
	async (source) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.gateway.play = async () => {
			f.calls.push(`play:${uri}:browser-device`);
			f.confirm(uri);
		};
		const previous = {
			paused: false,
			position: 1,
			duration: 200000,
			track_window: { current_track: { uri: next } },
		};
		if (source === "read") f.player.getCurrentState = async () => previous;
		await f.store.play();
		if (source === "event") f.emit("player_state_changed", previous);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.calls).not.toContain("pause");
		expect(f.calls).not.toContain("disconnect");
		// Unmatched metadata must stay honest and cannot grant selected-song controls.
		expect(f.store.getSnapshot().actualUri).toBe(next);
		await f.store.seek(60000);
		expect(f.calls).not.toContain("seek:60000");
		f.confirm(uri);
		expect(f.store.getSnapshot().paused).toBe(false);
		f.store.dispose();
	},
);
test("a Spotify-relinked song keeps playing and supports controls using its explicit original identity", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.gateway.play = async () => {
		f.calls.push(`play:${uri}:browser-device`);
		const relinked = {
			paused: false,
			position: 1,
			duration: 200000,
			track_window: { current_track: { uri: next, linked_from: { uri } } },
		};
		f.emit("player_state_changed", relinked);
	};
	await f.store.play();
	expect(f.calls).not.toContain("pause");
	expect(f.store.getSnapshot().actualUri).toBe(next);
	expect(f.store.getSnapshot().paused).toBe(false);
	await f.store.seek(60000);
	expect(f.calls).toContain("seek:60000");
	await f.store.togglePause();
	await f.store.togglePause();
	expect(f.calls).toContain("pause");
	expect(f.calls).toContain("resume");
	expect(f.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
	f.store.dispose();
});
test("a failed follow-up SDK read cannot disconnect accepted and event-confirmed playback", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	f.gateway.play = async () => f.confirm(uri);
	f.player.getCurrentState = async () => {
		throw new Error("SDK state is temporarily unavailable");
	};
	await f.store.play();
	expect(f.calls).not.toContain("disconnect");
	expect(f.store.getSnapshot().connection).toBe("ready");
	expect(f.store.getSnapshot().actualUri).toBe(uri);
	expect(f.store.getSnapshot().paused).toBe(false);
	expect(f.store.getSnapshot().busy).toBe(false);
	f.store.dispose();
});
test.each(["pause", "resume", "seek", "mute"] as const)(
	"a failed follow-up SDK read after %s keeps the player connected",
	async (control) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.confirm(uri);
		if (control === "resume") await f.store.togglePause();
		f.player.getCurrentState = async () => {
			throw new Error("SDK state is temporarily unavailable");
		};
		if (control === "seek") await f.store.seek(60000);
		else if (control === "mute") await f.store.toggleMute();
		else await f.store.togglePause();
		expect(f.calls).toContain(
			control === "seek"
				? "seek:60000"
				: control === "mute"
					? "volume:0"
					: control,
		);
		expect(f.calls).not.toContain("disconnect");
		expect(f.store.getSnapshot().connection).toBe("ready");
		expect(f.store.getSnapshot().busy).toBe(false);
		f.store.dispose();
	},
);
test("a genuine card change still pauses previous audio reported after the first pause", async () => {
	const f = fixture();
	f.store.select(uri, true);
	await f.store.enable();
	await f.store.play();
	f.confirm(uri);
	f.store.select(next, true);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.filter((call) => call === "pause")).toHaveLength(1);
	f.confirm(uri);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.filter((call) => call === "pause")).toHaveLength(2);
	expect(f.store.getSnapshot().paused).toBe(true);
	expect(f.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
	f.store.dispose();
});
test.each(["seek", "mute"] as const)(
	"a card change while %s authorization is pending still stops the previous song",
	async (control) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		await f.store.play();
		f.confirm(uri);
		let release!: () => void;
		f.gateway.authorize = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const operation =
			control === "seek" ? f.store.seek(60000) : f.store.toggleMute();
		f.store.select(next, true);
		release();
		await operation;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(f.calls).not.toContain(
			control === "seek" ? "seek:60000" : "volume:0",
		);
		expect(f.calls.filter((call) => call === "pause")).toHaveLength(1);
		expect(f.store.getSnapshot().paused).toBe(true);
		expect(f.calls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
		f.store.dispose();
	},
);
test.each(["different song", "null state", "device loss", "dispose"] as const)(
	"a previous linked identity cannot authorize seeking after %s",
	async (change) => {
		const f = fixture();
		f.store.select(uri, true);
		await f.store.enable();
		f.emit("player_state_changed", {
			paused: false,
			position: 1,
			duration: 200000,
			track_window: { current_track: { uri: next, linked_from: { uri } } },
		});
		await f.store.seek(60000);
		expect(f.calls).toContain("seek:60000");
		if (change === "different song")
			f.confirm(`spotify:track:${"2".repeat(22)}`);
		else if (change === "null state") f.emit("player_state_changed", null);
		else if (change === "device loss")
			f.emit("not_ready", { device_id: "browser-device" });
		else f.store.dispose();
		expect(f.store.getSnapshot().actualLinkedFromUri).toBeNull();
		await f.store.seek(90000);
		expect(f.calls).not.toContain("seek:90000");
		f.store.dispose();
	},
);
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
		expect(f.calls).not.toContain("pause");
		expect(f.store.getSnapshot().actualUri).toBe(next);
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

test.each(["reject", "resolve"] as const)(
	"Sign out stops SDK audio before the server can %s and fences late credentials",
	async (outcome) => {
		// Execute the actual UI event and server handler without mounting a browser.
		// SDK work uses the real store, including its asynchronous token/lifecycle guards.
		const appSource = readFileSync(
			new URL("../App.tsx", import.meta.url),
			"utf8",
		);
		const connectedSource = readFileSync(
			new URL("../components/Connected.tsx", import.meta.url),
			"utf8",
		);
		const eventName = appSource.match(
			/<button[^>]*onClick=\{(\w+)\}[^>]*>\s*Sign out/,
		)?.[1];
		expect(eventName).toBeDefined();
		const eventSource =
			eventName === "onLogout"
				? "onLogout"
				: appSource.match(
						new RegExp(`function ${eventName}\\(\\) \\{[\\s\\S]*?\\n\\t\\}`),
					)?.[0];
		const serverSource = connectedSource.match(
			/const logout = (async \(\) => \{[\s\S]*?\n\t\});/,
		)?.[1];
		expect(eventSource).toBeDefined();
		expect(serverSource).toBeDefined();
		const f = fixture();
		const unmount = f.store.retain();
		f.store.select(uri, true);
		await f.store.enable();
		f.confirm(uri);
		let finishToken!: (token: string) => void;
		let tokenRequests = 0;
		const pendingToken = new Promise<string>((resolve) => {
			finishToken = resolve;
		});
		f.gateway.token = () => {
			tokenRequests++;
			return pendingToken;
		};
		const credentials: string[] = [];
		f.options().getOAuthToken((token) => credentials.push(token));
		let finishLogout!: () => void;
		let rejectLogout!: (cause: Error) => void;
		const pendingLogout = new Promise<void>((resolve, reject) => {
			finishLogout = resolve;
			rejectLogout = reject;
		});
		let disconnectedAtRequest = 0;
		let session: object | null = { user: "owner" };
		const originalSession = session;
		let reportedError: string | null = null;
		let stopped = false;
		let serverCompletion: Promise<void> | undefined;
		const serverLogout = new Function(
			"api",
			"setSession",
			"setError",
			"window",
			"errorMessage",
			`return (${serverSource});`,
		)(
			{
				logout: () => {
					disconnectedAtRequest = f.calls.filter(
						(call) => call === "disconnect",
					).length;
					return pendingLogout;
				},
			},
			(value: null) => {
				session = value;
				unmount();
			},
			(value: string | null) => {
				reportedError = value;
			},
			{ location: { hash: "/review" } },
			(cause: Error) => cause.message,
		);
		const clickSignOut = new Function(
			"playback",
			"setPlaybackStopped",
			"onLogout",
			`return (${eventSource});`,
		)(
			{ store: f.store },
			(value: boolean) => {
				stopped = value;
			},
			() => {
				serverCompletion = serverLogout();
			},
		);
		try {
			clickSignOut();
			const duringLogout = f.store.getSnapshot();
			const callCount = f.calls.length;
			finishToken("late-test-only-sdk-credential");
			await new Promise((resolve) => setTimeout(resolve, 0));
			f.options().getOAuthToken((token) => credentials.push(token));
			await f.store.play();
			await f.store.togglePause();
			await f.store.seek(90000);
			await f.store.toggleMute();
			await f.store.enable();
			const callsWhilePending = f.calls.slice(callCount);
			if (outcome === "reject")
				rejectLogout(new Error("Logout request failed"));
			else finishLogout();
			await serverCompletion;
			f.options().getOAuthToken((token) => credentials.push(token));
			await new Promise((resolve) => setTimeout(resolve, 0));
			await f.store.play();
			await f.store.togglePause();
			await f.store.seek(90000);
			await f.store.toggleMute();
			expect(disconnectedAtRequest).toBe(1);
			expect(duringLogout.connection).toBe("idle");
			expect(duringLogout.paused).toBe(true);
			expect(duringLogout.actualUri).toBeNull();
			expect(stopped).toBe(true);
			expect(callsWhilePending).toEqual([]);
			expect(f.calls.slice(callCount)).toEqual([]);
			expect(tokenRequests).toBe(1);
			expect(credentials).toEqual([]);
			expect(JSON.stringify(f.store.getSnapshot())).not.toContain(
				"late-test-only-sdk-credential",
			);
			expect(session as object | null).toBe(
				outcome === "reject" ? originalSession : null,
			);
			expect(reportedError as string | null).toBe(
				outcome === "reject" ? "Logout request failed" : null,
			);
		} finally {
			finishToken("late-test-only-sdk-credential");
			finishLogout();
			f.store.dispose();
		}
	},
);
