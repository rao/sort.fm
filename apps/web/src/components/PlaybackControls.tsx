import { useEffect, useState, useSyncExternalStore } from "react";
import type { LiveGateway } from "../data/live-client";
import { PlayerStore } from "../state/player";
import { Icon } from "./ui";

export function PlaybackControls({
	gateway,
	trackUri,
	playable = true,
}: {
	gateway: LiveGateway;
	trackUri: string;
	playable?: boolean;
}) {
	const [store] = useState(() => new PlayerStore(gateway.api, gateway.session));
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);
	const supported = gateway.session.capabilities.playback;
	useEffect(() => {
		if (!supported) return;
		void store.refresh();
		const timer = setInterval(() => {
			if (!document.hidden) void store.refresh();
		}, 15000);
		return () => {
			clearInterval(timer);
			store.cancel();
		};
	}, [store, supported]);
	if (!playable)
		return (
			<div className="playback-controls">
				<span className="fine-print">
					Spotify marks this track unavailable. You can still open it in
					Spotify.
				</span>
			</div>
		);
	if (!supported)
		return (
			<div className="playback-controls">
				<span className="fine-print">
					Playback unavailable for this session. Listen in Spotify.
				</span>
			</div>
		);
	const playing = state.status?.isPlaying && state.status.trackUri === trackUri;
	const message =
		state.error ??
		(state.status?.isPlaying && state.status.trackUri !== trackUri
			? "Another song is playing on Spotify. Choose Play for this song."
			: state.message);
	return (
		<div className="playback-controls">
			<div className="playback-actions">
				<button
					type="button"
					className="button secondary small"
					disabled={state.busy || !!playing}
					onClick={() => void store.play(trackUri)}
				>
					<Icon name="headphones" size={16} />
					{state.busy
						? "Checking playback…"
						: playing
							? "Playing selected song"
							: "Play selected song"}
				</button>
				<button
					type="button"
					className="text-button"
					disabled={state.busy}
					onClick={() => void store.refresh()}
				>
					Check playback
				</button>
			</div>
			<output className="fine-print" aria-live="polite">
				{message}
			</output>
		</div>
	);
}
