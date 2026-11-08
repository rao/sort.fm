import type {
	SpotifyPlaybackState,
	SpotifySdkFactory,
	SpotifySdkPlayer,
} from "../data/spotify-sdk";

/** Internal port; the HTTP adapter must use the integration lead's shared contracts. */
export interface BrowserPlaybackGateway {
	authorize(): Promise<void>;
	token(): Promise<string>;
	play(
		trackUri: string,
		deviceId: string,
		isCurrent?: () => boolean,
	): Promise<void>;
}
export type BrowserPlayerState = {
	connection: "idle" | "connecting" | "ready" | "error";
	deviceId: string | null;
	selectedUri: string | null;
	playable: boolean;
	actualUri: string | null;
	actualLinkedFromUri: string | null;
	paused: boolean;
	positionMs: number;
	durationMs: number;
	updatedAt: number;
	busy: boolean;
	volume: number;
	volumeSupported: boolean;
	autoAdvance: boolean;
	canSeek: boolean;
	canPause: boolean;
	canResume: boolean;
	error: string | null;
	message: string;
};
export function playbackMatchesTrack(
	state: BrowserPlayerState,
	uri: string | null,
) {
	return (
		!!uri &&
		!!state.actualUri &&
		(state.actualUri === uri || state.actualLinkedFromUri === uri)
	);
}
export class BrowserPlayerStore {
	private state: BrowserPlayerState;
	private listeners = new Set<() => void>();
	private player: SpotifySdkPlayer | null = null;
	private epoch = 0;
	private selection = 0;
	private stateRevision = 0;
	private autoSelection: number | null = null;
	private pauseForSelectionChange = false;
	private disposed = false;
	private retainCount = 0;
	private armed = false;
	private previousVolume = 0.6;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	constructor(
		private gateway: BrowserPlaybackGateway,
		private factory: SpotifySdkFactory,
		private options: {
			volumeSupported: boolean;
			volume?: number;
			saveVolume?: (value: number) => void;
			readyTimeoutMs?: number;
			operationTimeoutMs?: number;
		},
	) {
		const volume = Number.isFinite(options.volume)
			? Math.max(0, Math.min(1, options.volume!))
			: 0.6;
		this.previousVolume = volume || 0.6;
		this.state = {
			connection: "idle",
			deviceId: null,
			selectedUri: null,
			playable: false,
			actualUri: null,
			actualLinkedFromUri: null,
			paused: true,
			positionMs: 0,
			durationMs: 0,
			updatedAt: Date.now(),
			busy: false,
			volume,
			volumeSupported: options.volumeSupported,
			autoAdvance: false,
			canSeek: false,
			canPause: false,
			canResume: false,
			error: null,
			message:
				"Enable the browser player to listen here. Spotify Premium is required.",
		};
	}
	private deadline<T>(promise: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Playback timed out")),
				this.options.operationTimeoutMs ?? 15000,
			);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
	// React StrictMode can release and retain synchronously; real unmount still disconnects.
	retain() {
		this.disposed = false;
		this.retainCount++;
		return () => {
			this.retainCount--;
			queueMicrotask(() => {
				if (this.retainCount === 0) this.dispose();
			});
		};
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<BrowserPlayerState>) {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private clearTimer() {
		if (this.readyTimer) clearTimeout(this.readyTimer);
		this.readyTimer = null;
	}
	private disconnect() {
		this.clearTimer();
		this.epoch++;
		const player = this.player;
		this.player = null;
		if (player) {
			for (const name of [
				"ready",
				"not_ready",
				"player_state_changed",
				"initialization_error",
				"authentication_error",
				"account_error",
				"playback_error",
				"autoplay_failed",
			] as const)
				player.removeListener(name);
			player.disconnect();
		}
	}
	private fail(message: string) {
		this.disconnect();
		this.armed = false;
		this.update({
			connection: "error",
			busy: false,
			deviceId: null,
			actualUri: null,
			actualLinkedFromUri: null,
			paused: true,
			canSeek: false,
			canPause: false,
			canResume: false,
			positionMs: 0,
			durationMs: 0,
			error: message,
			message:
				"Playback is unavailable. Reconnect or open the song in Spotify.",
		});
	}
	private async authorize() {
		const epoch = this.epoch;
		try {
			await this.deadline(this.gateway.authorize());
		} catch {
			if (epoch === this.epoch)
				this.fail(
					"Your playback session needs authorization. Reconnect Spotify playback before continuing.",
				);
			throw new Error("Playback authorization required");
		}
	}
	select(uri: string | null, playable: boolean) {
		if (uri === this.state.selectedUri && playable === this.state.playable)
			return;
		if (this.state.selectedUri !== null && uri !== this.state.selectedUri)
			this.pauseForSelectionChange = true;
		this.selection++;
		this.autoSelection =
			this.state.autoAdvance && this.armed ? this.selection : null;
		this.update({ selectedUri: uri, playable, error: null });
		void this.reconcileSelection();
	}
	setAutoAdvance(value: boolean) {
		this.update({ autoAdvance: value });
	}
	private async reconcileSelection() {
		if (
			this.disposed ||
			this.state.busy ||
			this.state.connection !== "ready" ||
			!this.player
		)
			return;
		if (
			this.state.autoAdvance &&
			this.armed &&
			this.state.selectedUri &&
			this.state.playable &&
			!playbackMatchesTrack(this.state, this.state.selectedUri) &&
			this.autoSelection === this.selection
		) {
			this.autoSelection = null;
			await this.play(false);
			return;
		}
		if (
			this.pauseForSelectionChange &&
			this.state.actualUri &&
			!playbackMatchesTrack(this.state, this.state.selectedUri) &&
			!this.state.paused
		) {
			const player = this.player,
				epoch = this.epoch;
			this.update({ busy: true });
			try {
				await this.deadline(player.pause());
				if (epoch === this.epoch) await this.readState(player, epoch);
			} catch {
				if (epoch === this.epoch)
					this.fail(
						"Could not pause the previous song. The browser player was disconnected; reconnect to continue.",
					);
			} finally {
				if (epoch === this.epoch) this.update({ busy: false });
			}
		}
	}
	async enable() {
		if (this.disposed || this.state.busy || this.state.connection === "ready")
			return;
		this.disconnect();
		const epoch = this.epoch;
		this.update({
			connection: "connecting",
			busy: true,
			error: null,
			message: "Connecting Spotify's browser player…",
		});
		try {
			await this.authorize();
			if (this.disposed || epoch !== this.epoch) return;
			const player = await this.deadline(
				this.factory({
					name: "sort.fm",
					volume: this.state.volume,
					getOAuthToken: (callback) => {
						if (this.disposed || epoch !== this.epoch) return;
						void this.deadline(this.gateway.token())
							.then((token) => {
								if (!this.disposed && epoch === this.epoch) callback(token);
							})
							.catch(() => {
								if (epoch === this.epoch)
									this.fail(
										"Spotify playback authorization expired or is unavailable. Reconnect playback.",
									);
							});
					},
				}).then((created) => {
					if (this.disposed || epoch !== this.epoch) created.disconnect();
					return created;
				}),
			);
			if (this.disposed || epoch !== this.epoch) {
				player.disconnect();
				return;
			}
			this.player = player;
			const current = () => !this.disposed && epoch === this.epoch;
			player.addListener("ready", ({ device_id }) => {
				if (!current()) return;
				this.clearTimer();
				this.update({
					connection: "ready",
					busy: false,
					deviceId: device_id,
					error: null,
					message: "Browser player ready. Choose Play for this song.",
				});
			});
			player.addListener("not_ready", () => {
				if (current())
					this.fail(
						"Spotify disconnected this browser device. Reconnect the player to continue.",
					);
			});
			player.addListener("player_state_changed", (value) => {
				if (current()) this.acceptState(value);
			});
			for (const [event, message] of [
				[
					"initialization_error",
					"This browser cannot initialize protected Spotify playback. Try a supported browser or Open in Spotify.",
				],
				[
					"authentication_error",
					"Spotify playback authorization was rejected. Reconnect playback.",
				],
				["account_error", "Spotify Premium is required for browser playback."],
				[
					"playback_error",
					"Spotify could not play this song. Try again or open it in Spotify.",
				],
			] as const)
				player.addListener(event, () => {
					if (current()) this.fail(message);
				});
			player.addListener("autoplay_failed", () => {
				if (current()) {
					this.armed = false;
					this.update({
						paused: true,
						error:
							"Your browser needs another click. Choose Play to enable audio.",
						message: "Audio is paused by the browser.",
					});
				}
			});
			this.readyTimer = setTimeout(() => {
				if (current())
					this.fail(
						"Spotify's browser device did not become ready. Reconnect or open Spotify.",
					);
			}, this.options.readyTimeoutMs ?? 20000);
			const connected = await this.deadline(player.connect());
			if (current() && !connected)
				this.fail(
					"Spotify could not connect this browser player. Try reconnecting.",
				);
		} catch {
			if (epoch === this.epoch)
				this.fail(
					"Spotify's browser player could not connect. Reconnect playback or open Spotify.",
				);
		}
	}
	private acceptState(value: SpotifyPlaybackState | null) {
		this.stateRevision++;
		if (!value) {
			this.update({
				actualUri: null,
				actualLinkedFromUri: null,
				paused: true,
				positionMs: 0,
				durationMs: 0,
				canSeek: false,
				canPause: false,
				canResume: false,
			});
			return;
		}
		if (
			!Number.isFinite(value.position) ||
			!Number.isFinite(value.duration) ||
			value.duration < 0
		)
			return;
		const track = value.track_window.current_track;
		const identity = {
			actualUri: track.uri,
			actualLinkedFromUri:
				typeof track.linked_from?.uri === "string"
					? track.linked_from.uri
					: null,
		};
		this.update({
			...identity,
			paused: value.paused,
			positionMs: Math.max(0, Math.min(value.position, value.duration)),
			durationMs: value.duration,
			updatedAt: Date.now(),
			canSeek: !value.disallows?.seeking,
			canPause: !value.disallows?.pausing,
			canResume: !value.disallows?.resuming,
			message: playbackMatchesTrack(
				{ ...this.state, ...identity },
				this.state.selectedUri,
			)
				? value.paused
					? "Paused."
					: "Playing this song in your browser."
				: "The player is on another song. Choose Play for the displayed song.",
		});
		if (this.pauseForSelectionChange) void this.reconcileSelection();
	}
	private async readState(player: SpotifySdkPlayer, epoch: number) {
		const selection = this.selection,
			revision = this.stateRevision;
		let value: SpotifyPlaybackState | null;
		try {
			value = await this.deadline(player.getCurrentState());
		} catch {
			// A metadata read cannot undo an accepted play/control or a newer SDK event.
			// Keep the last observation until an event or the next explicit/poll read.
			return;
		}
		if (
			!this.disposed &&
			epoch === this.epoch &&
			selection === this.selection &&
			revision === this.stateRevision
		)
			this.acceptState(value);
	}
	async refresh() {
		if (
			this.disposed ||
			this.state.busy ||
			this.state.connection !== "ready" ||
			!this.player
		)
			return;
		const player = this.player,
			epoch = this.epoch;
		try {
			await this.authorize();
			if (epoch === this.epoch) await this.readState(player, epoch);
		} catch {
			/* authorize already gives a safe message; a missing SDK read stays unconfirmed */
		}
	}
	async play(userGesture = true) {
		const player = this.player,
			uri = this.state.selectedUri,
			device = this.state.deviceId;
		if (
			this.disposed ||
			this.state.busy ||
			this.state.connection !== "ready" ||
			!player ||
			!uri ||
			!device ||
			!this.state.playable
		)
			return;
		const epoch = this.epoch,
			selection = this.selection;
		const isCurrent = () =>
			!this.disposed &&
			epoch === this.epoch &&
			selection === this.selection &&
			(userGesture || (this.state.autoAdvance && this.armed));
		// Invoke synchronously in the click event, before awaiting authorization.
		let activationCall: Promise<void>;
		try {
			activationCall = userGesture
				? player.activateElement()
				: Promise.resolve();
		} catch {
			activationCall = Promise.reject(new Error("Audio activation failed"));
		}
		const activation = activationCall.then(
			() => null,
			() => new Error("Audio needs another user gesture"),
		);
		this.update({ busy: true, error: null, message: "Requesting this song…" });
		try {
			await this.authorize();
			const activationError = await this.deadline(activation);
			if (activationError) throw activationError;
			if (!isCurrent()) return;
			this.armed = true;
			// Only a real card change may pause previous audio. Spotify can report a
			// relinked URI or delayed previous-track metadata after accepting this play.
			this.pauseForSelectionChange = false;
			await this.deadline(this.gateway.play(uri, device, isCurrent));
			if (epoch !== this.epoch || this.disposed) return;
			if (!isCurrent()) {
				await this.deadline(player.pause());
				return;
			}
			await this.readState(player, epoch);
			if (!playbackMatchesTrack(this.state, uri) || this.state.paused)
				this.update({
					message:
						"Playback requested; waiting for Spotify to confirm this song.",
				});
		} catch {
			if (epoch === this.epoch)
				this.fail(
					"Playback was not confirmed. Reconnect the player or open Spotify.",
				);
		} finally {
			if (epoch === this.epoch) {
				this.update({ busy: false });
				void this.reconcileSelection();
			}
		}
	}
	private async control(action: (player: SpotifySdkPlayer) => Promise<void>) {
		if (
			this.disposed ||
			this.state.busy ||
			this.state.connection !== "ready" ||
			!this.player
		)
			return;
		const player = this.player,
			epoch = this.epoch,
			selection = this.selection;
		this.update({ busy: true, error: null });
		try {
			await this.authorize();
			if (epoch !== this.epoch || selection !== this.selection || this.disposed)
				return;
			await this.deadline(action(player));
			if (epoch === this.epoch) await this.readState(player, epoch);
		} catch {
			if (epoch === this.epoch)
				this.fail(
					"Spotify could not apply that playback control. Reconnect the player.",
				);
		} finally {
			if (epoch === this.epoch) {
				this.update({ busy: false });
				void this.reconcileSelection();
			}
		}
	}
	async togglePause() {
		if (
			!this.state.selectedUri ||
			!playbackMatchesTrack(this.state, this.state.selectedUri)
		)
			return this.play();
		if (
			(this.state.paused && !this.state.canResume) ||
			(!this.state.paused && !this.state.canPause)
		)
			return;
		const pause = !this.state.paused;
		const epoch = this.epoch,
			selection = this.selection;
		// Resume also needs synchronous activation on browsers that suspend audio.
		if (this.state.busy || this.state.connection !== "ready" || !this.player)
			return;
		let activationCall: Promise<void>;
		try {
			activationCall = pause
				? Promise.resolve()
				: this.player.activateElement();
		} catch {
			activationCall = Promise.reject(new Error("Audio activation failed"));
		}
		const activation = activationCall.then(
			() => null,
			() => new Error("Audio needs another click"),
		);
		return this.control(async (player) => {
			const error = await activation;
			if (error) throw error;
			if (
				this.disposed ||
				epoch !== this.epoch ||
				selection !== this.selection ||
				!playbackMatchesTrack(this.state, this.state.selectedUri) ||
				(pause ? !this.state.canPause : !this.state.canResume)
			)
				return;
			// Explicit resume authorizes this card again, just like a targeted play.
			// Clear only after all asynchronous authorization/activation fences pass.
			if (!pause) this.pauseForSelectionChange = false;
			await (pause ? player.pause() : player.resume());
		});
	}
	async seek(position: number) {
		if (
			!this.state.canSeek ||
			!playbackMatchesTrack(this.state, this.state.selectedUri) ||
			!Number.isFinite(position)
		)
			return;
		const target = Math.max(
			0,
			Math.min(position, Math.max(0, this.state.durationMs - 1)),
		);
		return this.control(async (player) => {
			if (
				!playbackMatchesTrack(this.state, this.state.selectedUri) ||
				!this.state.canSeek
			)
				return;
			await player.seek(target);
		});
	}
	async setVolume(volume: number) {
		if (!this.state.volumeSupported || !Number.isFinite(volume)) return;
		const target = Math.max(0, Math.min(1, volume));
		const epoch = this.epoch;
		return this.control(async (player) => {
			await player.setVolume(target);
			if (this.disposed || epoch !== this.epoch) return;
			if (target > 0) this.previousVolume = target;
			this.update({ volume: target });
			try {
				this.options.saveVolume?.(target);
			} catch {
				/* Optional preference persistence never affects audio. */
			}
		});
	}
	async toggleMute() {
		return this.setVolume(this.state.volume === 0 ? this.previousVolume : 0);
	}
	dispose() {
		this.disconnect();
		this.armed = false;
		this.update({
			connection: "idle",
			busy: false,
			deviceId: null,
			actualUri: null,
			actualLinkedFromUri: null,
			paused: true,
			positionMs: 0,
			durationMs: 0,
			canSeek: false,
			canPause: false,
			canResume: false,
		});
		this.disposed = true;
		this.listeners.clear();
	}
}
