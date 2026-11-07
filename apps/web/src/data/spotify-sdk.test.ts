import { expect, test } from "bun:test";
import { loadSpotifySdk, supportsBrowserVolume } from "./spotify-sdk";

test("SDK loader fails safely outside the browser and never fetches a token itself", async () => {
	await expect(loadSpotifySdk()).rejects.toThrow(
		"Browser playback is unavailable",
	);
});
test("iOS volume cannot be advertised as script-controlled", () => {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	try {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 1 },
		});
		expect(supportsBrowserVolume()).toBe(false);
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { userAgent: "Safari", platform: "MacIntel", maxTouchPoints: 5 },
		});
		expect(supportsBrowserVolume()).toBe(false);
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { userAgent: "Chrome", platform: "MacIntel", maxTouchPoints: 0 },
		});
		expect(supportsBrowserVolume()).toBe(true);
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
		else Reflect.deleteProperty(globalThis, "navigator");
	}
});

test("official SDK script is single-flight and a failed load can be retried", async () => {
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const target: {
		Spotify?: unknown;
		onSpotifyWebPlaybackSDKReady?: () => void;
	} = {};
	const scripts: {
		src: string;
		async: boolean;
		onerror: (() => void) | null;
		remove(): void;
	}[] = [];
	try {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: target,
		});
		Object.defineProperty(globalThis, "document", {
			configurable: true,
			value: {
				createElement: () => ({
					src: "",
					async: false,
					onerror: null,
					remove() {},
				}),
				head: {
					appendChild(script: (typeof scripts)[number]) {
						scripts.push(script);
					},
				},
			},
		});
		const first = loadSpotifySdk();
		const second = loadSpotifySdk();
		expect(first).toBe(second);
		expect(scripts).toHaveLength(1);
		expect(scripts[0]!.src).toBe("https://sdk.scdn.co/spotify-player.js");
		scripts[0]!.onerror!();
		await expect(first).rejects.toThrow("could not load");
		const retry = loadSpotifySdk();
		expect(scripts).toHaveLength(2);
		target.Spotify = { Player: class {} };
		target.onSpotifyWebPlaybackSDKReady!();
		expect(Object.is(await retry, target.Spotify)).toBe(true);
	} finally {
		if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
		else Reflect.deleteProperty(globalThis, "document");
	}
});
