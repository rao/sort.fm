/** Browser-only Spotify transport. Tokens are passed straight to the SDK, never stored. */
export type SpotifyPlaybackState = {
	paused: boolean;
	position: number;
	duration: number;
	track_window: {
		current_track: {
			uri: string;
			// Web API-compatible metadata may identify a relinked original track.
			// The SDK does not guarantee this field; never infer it from a play response.
			linked_from?: { uri?: string } | null;
		};
	};
	disallows?: { pausing?: boolean; resuming?: boolean; seeking?: boolean };
};
export type SpotifySdkEvents = {
	ready: { device_id: string };
	not_ready: { device_id: string };
	player_state_changed: SpotifyPlaybackState | null;
	initialization_error: { message: string };
	authentication_error: { message: string };
	account_error: { message: string };
	playback_error: { message: string };
	autoplay_failed: undefined;
};
export interface SpotifySdkPlayer {
	addListener<K extends keyof SpotifySdkEvents>(
		name: K,
		callback: (event: SpotifySdkEvents[K]) => void,
	): boolean;
	removeListener(name: keyof SpotifySdkEvents): boolean;
	connect(): Promise<boolean>;
	disconnect(): void;
	activateElement(): Promise<void>;
	getCurrentState(): Promise<SpotifyPlaybackState | null>;
	pause(): Promise<void>;
	resume(): Promise<void>;
	seek(position: number): Promise<void>;
	setVolume(volume: number): Promise<void>;
}
export type SpotifySdkOptions = {
	name: string;
	volume: number;
	getOAuthToken: (callback: (token: string) => void) => void;
};
export type SpotifySdk = {
	Player: new (options: SpotifySdkOptions) => SpotifySdkPlayer;
};
export type SpotifySdkFactory = (
	options: SpotifySdkOptions,
) => Promise<SpotifySdkPlayer>;
type SpotifyWindow = Window & {
	Spotify?: SpotifySdk;
	onSpotifyWebPlaybackSDKReady?: () => void;
};
let loading: Promise<SpotifySdk> | null = null;
const source = "https://sdk.scdn.co/spotify-player.js";
export function loadSpotifySdk(): Promise<SpotifySdk> {
	if (typeof window === "undefined")
		return Promise.reject(new Error("Browser playback is unavailable here."));
	const target = window as SpotifyWindow;
	if (target.Spotify?.Player) return Promise.resolve(target.Spotify);
	if (loading) return loading;
	loading = new Promise<SpotifySdk>((resolve, reject) => {
		const script = document.createElement("script");
		const previous = target.onSpotifyWebPlaybackSDKReady;
		let settled = false;
		const finish = (sdk?: SpotifySdk) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			script.onerror = null;
			if (target.onSpotifyWebPlaybackSDKReady === ready)
				target.onSpotifyWebPlaybackSDKReady = previous;
			if (sdk) resolve(sdk);
			else {
				script.remove();
				loading = null;
				reject(
					new Error(
						"Spotify's player could not load. Check your connection or use Open in Spotify.",
					),
				);
			}
		};
		const ready = () => {
			finish(target.Spotify);
			previous?.();
		};
		const timer = setTimeout(() => finish(), 15000);
		target.onSpotifyWebPlaybackSDKReady = ready;
		script.src = source;
		script.async = true;
		script.onerror = () => finish();
		document.head.appendChild(script);
	});
	return loading;
}
export const createSpotifySdkPlayer: SpotifySdkFactory = async (options) => {
	const sdk = await loadSpotifySdk();
	return new sdk.Player(options);
};
export function supportsBrowserVolume() {
	if (typeof navigator === "undefined") return false;
	return !(
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
	);
}
