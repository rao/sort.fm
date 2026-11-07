import type { AccountSession } from "@sortfm/contracts";
import { PlayRequestSchema } from "@sortfm/contracts";
import { errorMessage, type LiveApi } from "../data/live-client";

type Status = Awaited<ReturnType<LiveApi["playerStatus"]>>;
export type PlayerState = {
	busy: boolean;
	status: Status | null;
	error: string | null;
	message: string;
};

/** Backend-controlled playback on an existing device. Never obtains provider tokens. */
export class PlayerStore {
	private state: PlayerState = {
		busy: false,
		status: null,
		error: null,
		message: "Choose Play to listen on your Spotify device.",
	};
	private listeners = new Set<() => void>();
	private owner: string | null;
	private generation = 0;
	constructor(
		private api: LiveApi,
		session: AccountSession,
	) {
		this.owner = session.mode === "spotify" ? (session.user?.id ?? null) : null;
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<PlayerState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	// Cancel pending preparation when the owning UI is unmounted (including logout).
	cancel() {
		this.generation++;
		this.update({ busy: false });
	}
	private async authorize() {
		if (!this.owner) throw new Error("Playback is unavailable in demo mode.");
		const session = await this.api.session();
		if (session.mode !== "spotify" || session.user?.id !== this.owner)
			throw new Error("Your account changed. Reconnect before playback.");
		if (!session.capabilities.playback)
			throw new Error(
				"Playback is not enabled for this session. Open this song in Spotify.",
			);
	}
	async refresh() {
		if (this.state.busy) return;
		const generation = this.generation;
		this.update({ busy: true, error: null });
		try {
			await this.authorize();
			if (generation !== this.generation) return;
			const status = await this.api.playerStatus();
			if (generation !== this.generation) return;
			this.update({
				status,
				message: status.available
					? status.isPlaying
						? "Playing on your Spotify device."
						: "Spotify device ready. Choose Play to listen."
					: (status.reason ??
						"Open Spotify and select an available device, then check again."),
			});
		} catch (error) {
			if (generation === this.generation)
				this.update({ status: null, error: errorMessage(error) });
		} finally {
			if (generation === this.generation) this.update({ busy: false });
		}
	}
	async play(trackUri: string) {
		if (this.state.busy) return;
		const generation = this.generation;
		this.update({
			busy: true,
			error: null,
			message: "Checking your Spotify device…",
		});
		try {
			PlayRequestSchema.parse({ trackUri });
			await this.authorize();
			if (generation !== this.generation) return;
			const status = await this.api.playerStatus();
			if (generation !== this.generation) return;
			this.update({ status });
			if (!status.available || !status.deviceId) {
				this.update({
					message:
						status.reason ??
						"Open Spotify and select an available device, then check again.",
				});
				return;
			}
			this.update({ message: "Requesting playback…" });
			await this.api.play(trackUri);
			if (generation !== this.generation) return;
			const confirmed = await this.api.playerStatus();
			if (generation !== this.generation) return;
			this.update({
				status: confirmed,
				message:
					confirmed.isPlaying && confirmed.trackUri === trackUri
						? "Playing on your Spotify device."
						: "Playback requested; audio is not confirmed yet. Check playback or open Spotify.",
			});
		} catch (error) {
			if (generation === this.generation)
				this.update({
					status: null,
					error: errorMessage(error),
					message:
						"Playback was not confirmed. Check playback before trying again.",
				});
		} finally {
			if (generation === this.generation) this.update({ busy: false });
		}
	}
}
