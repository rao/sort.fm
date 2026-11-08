import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TrackCard, PlaybackConnectionStatus } from "@sortfm/contracts";
import {
	type BrowserPlayerStore,
	type BrowserPlayerState,
	playbackMatchesTrack,
} from "../state/browser-player";
import { RiArrowUpSLine } from "@remixicon/react";
import { Cover, Icon } from "./ui";
import { AutoplayToggle } from "./AutoplayToggle";

export type PlaybackConnection = PlaybackConnectionStatus;
export interface PlaybackConnectionGateway {
	connection(): Promise<PlaybackConnection>;
	connect(returnTo: "review" | "calibration"): Promise<string>;
}
export function BrowserPlayback({
	store,
	gateway,
	track,
	returnTo,
}: {
	store: BrowserPlayerStore;
	gateway: PlaybackConnectionGateway;
	track: TrackCard | null;
	returnTo: "review" | "calibration";
}) {
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	const [connection, setConnection] = useState<PlaybackConnection | null>(null);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());
	const lifecycle = useRef(0);
	const pending = useRef(false);
	useEffect(() => store.retain(), [store]);
	useEffect(() => {
		store.select(track?.spotifyUri ?? null, track?.isPlayable ?? false);
	}, [store, track?.spotifyUri, track?.isPlayable]);
	useEffect(() => {
		const generation = ++lifecycle.current;
		pending.current = true;
		setChecking(true);
		setConnection(null);
		setError(null);
		void gateway
			.connection()
			.then((value) => {
				if (generation === lifecycle.current) {
					setConnection(value);
					setError(null);
				}
			})
			.catch(() => {
				if (generation === lifecycle.current)
					setError(
						"Browser playback is unavailable. Check the connection or use Open in Spotify.",
					);
			})
			.finally(() => {
				if (generation === lifecycle.current) {
					pending.current = false;
					setChecking(false);
				}
			});
		return () => {
			lifecycle.current++;
			pending.current = false;
		};
	}, [gateway]);
	useEffect(() => {
		const clock = setInterval(() => setNow(Date.now()), 1000);
		const poll = setInterval(() => {
			if (!document.hidden) void store.refresh();
		}, 5000);
		return () => {
			clearInterval(clock);
			clearInterval(poll);
		};
	}, [store]);
	async function check() {
		if (pending.current) return;
		const generation = lifecycle.current;
		pending.current = true;
		setChecking(true);
		setError(null);
		try {
			const value = await gateway.connection();
			if (generation !== lifecycle.current) return;
			setConnection(value);
			await store.refresh();
		} catch {
			if (generation === lifecycle.current)
				setError(
					"Could not check playback availability. Try again or open Spotify.",
				);
		} finally {
			if (generation === lifecycle.current) {
				pending.current = false;
				setChecking(false);
			}
		}
	}
	async function connect() {
		if (pending.current) return;
		const generation = lifecycle.current;
		pending.current = true;
		setChecking(true);
		setError(null);
		try {
			const url = await gateway.connect(returnTo);
			if (generation !== lifecycle.current) return;
			window.location.assign(url);
		} catch {
			if (generation !== lifecycle.current) return;
			setError(
				"Could not start playback authorization. Try checking the connection again.",
			);
			pending.current = false;
			setChecking(false);
		}
	}
	return (
		<BrowserPlaybackView
			key={track?.spotifyUri ?? "no-song"}
			state={state}
			track={track}
			connection={connection}
			checking={checking}
			error={error}
			now={now}
			onEnable={() => void store.enable()}
			onConnect={() => void connect()}
			onCheck={() => void check()}
			onPlay={() => void store.play()}
			onPause={() => void store.togglePause()}
			onSeek={(value) => void store.seek(value)}
			onMute={() => void store.toggleMute()}
			onVolume={(value) => void store.setVolume(value)}
			onAuto={(value) => store.setAutoAdvance(value)}
		/>
	);
}
type Props = {
	state: BrowserPlayerState;
	track: TrackCard | null;
	connection: PlaybackConnection | null;
	checking: boolean;
	error: string | null;
	now: number;
	onEnable(): void;
	onConnect(): void;
	onCheck(): void;
	onPlay(): void;
	onPause(): void;
	onSeek(value: number): void;
	onMute(): void;
	onVolume(value: number): void;
	onAuto(value: boolean): void;
};
function time(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function BrowserPlaybackView(props: Props) {
	const { state, track, connection, checking, error, now } = props;
	const matching =
		!!track?.spotifyUri &&
		playbackMatchesTrack(state, track.spotifyUri) &&
		state.selectedUri === track.spotifyUri;
	const sdkReady = state.connection === "ready";
	const ready = sdkReady && connection?.status === "ready";
	const enabled =
		!!track?.isPlayable && !!track.spotifyUri && ready && !state.busy;
	const position = matching
		? Math.min(
				state.durationMs,
				state.positionMs +
					(state.paused ? 0 : Math.max(0, now - state.updatedAt)),
			)
		: 0;
	const duration = matching ? state.durationMs : (track?.durationMs ?? 0);
	const [seekDraft, setSeekDraft] = useState<number | null>(null);
	const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
	const commitSeek = () => {
		if (seekDraft !== null) {
			props.onSeek(seekDraft);
			setSeekDraft(null);
		}
	};
	const commitVolume = () => {
		if (volumeDraft !== null) {
			props.onVolume(volumeDraft / 100);
			setVolumeDraft(null);
		}
	};
	return (
		<section className="browser-playback" aria-label="Spotify browser player">
			<div className="player-track">
				{track && <Cover track={track} />}
				<div>
					<strong>{track?.title ?? "Choose a song to listen"}</strong>
					<span>
						{track?.artists.map((artist) => artist.name).join(", ") ??
							"Playback follows your calibration or review card."}
					</span>
				</div>
			</div>
			<div className="browser-player-main">
				<div className="browser-player-buttons">
					{sdkReady && (ready || matching) && (
						<button
							type="button"
							className="button secondary small"
							disabled={
								state.busy ||
								(matching
									? state.paused
										? !state.canResume
										: !state.canPause
									: !enabled)
							}
							onClick={matching ? props.onPause : props.onPlay}
						>
							{state.busy
								? "Working…"
								: matching && !state.paused
									? "Pause"
									: "Play this song"}
						</button>
					)}
					{!ready &&
						(connection?.status === "ready" ? (
							<button
								type="button"
								className="button secondary small"
								disabled={state.busy || checking}
								onClick={props.onEnable}
							>
								{state.connection === "connecting"
									? "Connecting player…"
									: state.connection === "error"
										? "Reconnect player"
										: "Enable browser player"}
							</button>
						) : connection?.status === "reconnect_required" ? (
							<button
								type="button"
								className="button secondary small"
								disabled={checking}
								onClick={props.onConnect}
							>
								Connect Spotify playback
							</button>
						) : (
							<span className="fine-print">
								{checking
									? "Checking playback…"
									: connection?.status === "premium_required"
										? "Spotify Premium required"
										: "Browser playback unavailable"}
							</span>
						))}
				</div>
				<label className="browser-seek">
					<span>{time(seekDraft ?? position)}</span>
					<input
						type="range"
						aria-label="Seek within this song"
						min={0}
						max={Math.max(1, duration - 1)}
						step={1000}
						value={seekDraft ?? position}
						disabled={
							!sdkReady ||
							state.busy ||
							!matching ||
							!state.canSeek ||
							duration === 0
						}
						onChange={(event) =>
							setSeekDraft(Number(event.currentTarget.value))
						}
						onPointerUp={commitSeek}
						onKeyUp={commitSeek}
						onBlur={commitSeek}
					/>
					<span>{time(duration)}</span>
				</label>
			</div>
			<details className="browser-player-settings">
				<summary aria-label="Player options">
					Options <RiArrowUpSLine aria-hidden="true" size={16} />
				</summary>
				<div className="browser-player-options">
					<button
						type="button"
						className="text-button"
						disabled={checking || state.busy}
						onClick={props.onCheck}
					>
						Check connection
					</button>
					{state.volumeSupported ? (
						<div className="browser-volume">
							<button
								type="button"
								className="text-button"
								disabled={!sdkReady || state.busy}
								onClick={props.onMute}
								aria-pressed={state.volume === 0}
							>
								{state.volume === 0 ? "Unmute" : "Mute"}
							</button>
							<input
								type="range"
								aria-label="Playback volume"
								min={0}
								max={100}
								step={1}
								value={volumeDraft ?? Math.round(state.volume * 100)}
								disabled={!sdkReady || state.busy}
								onChange={(event) =>
									setVolumeDraft(Number(event.currentTarget.value))
								}
								onPointerUp={commitVolume}
								onKeyUp={commitVolume}
								onBlur={commitVolume}
							/>
						</div>
					) : (
						<span className="fine-print">
							Use your device's volume buttons.
						</span>
					)}
					<AutoplayToggle checked={state.autoAdvance} onChange={props.onAuto} />
					<p className="browser-player-detail-message">
						{connection?.reason ?? state.message}
					</p>
				</div>
			</details>

			{track && (
				<a
					className="text-link browser-open-spotify"
					href={`https://open.spotify.com/track/${track.trackId}`}
					target="_blank"
					rel="noreferrer"
				>
					Open in Spotify <Icon name="external" size={13} />
				</a>
			)}
			<output className="browser-player-message" aria-live="polite">
				{error ??
					state.error ??
					(track && !track.isPlayable
						? "This track is unavailable for playback."
						: "")}
			</output>
		</section>
	);
}
