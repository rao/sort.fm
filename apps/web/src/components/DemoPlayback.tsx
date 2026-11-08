import { useEffect, useRef, useState } from "react";
import type { TrackCard } from "@sortfm/contracts";
import { RiPlayFill, RiPauseFill } from "@remixicon/react";
import { demoPreview } from "../data/demo-catalog";
import { AutoplayToggle } from "./AutoplayToggle";

const clock = (seconds: number) =>
	`${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
		.toString()
		.padStart(2, "0")}`;
export function DemoPlayback({ track }: { track: TrackCard }) {
	const [autoplay, setAutoplay] = useState(false);
	// Selection changes replace the media element; the user's autoplay choice persists.
	return (
		<TrackPreview
			key={track.trackId}
			track={track}
			autoplay={autoplay}
			onAutoplay={setAutoplay}
		/>
	);
}
function TrackPreview({
	track,
	autoplay,
	onAutoplay,
}: {
	track: TrackCard;
	autoplay: boolean;
	onAutoplay: (enabled: boolean) => void;
}) {
	const preview = demoPreview(track.trackId);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [playing, setPlaying] = useState(false);
	const [position, setPosition] = useState(0);
	const [duration, setDuration] = useState(0);
	const [message, setMessage] = useState("");
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const audio = audioRef.current;
		let active = true;
		if (autoplay && audio)
			void audio.play().catch((error: unknown) => {
				if (
					active &&
					!(error instanceof DOMException && error.name === "AbortError")
				)
					setMessage("Press play to start this preview.");
			});
		return () => {
			active = false;
		};
	}, [autoplay]);
	useEffect(() => {
		const audio = audioRef.current;
		return () => {
			audio?.pause();
		};
	}, []);
	async function toggle() {
		const audio = audioRef.current;
		if (!audio) return;
		if (!audio.paused) {
			audio.pause();
			return;
		}
		setMessage("");
		if (failed) {
			setFailed(false);
			audio.load();
		}
		try {
			await audio.play();
		} catch (error) {
			if (!(error instanceof DOMException && error.name === "AbortError"))
				setMessage("Preview unavailable. Try play again or listen in full.");
		}
	}
	if (!preview) return <span>Preview unavailable for this song.</span>;
	return (
		<div className="demo-preview">
			{/* biome-ignore lint/a11y/useMediaCaption: Music excerpts have no supplied caption track; accessible playback controls and title are shown alongside. */}
			<audio
				ref={audioRef}
				preload="none"
				src={preview.previewUrl}
				onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
				onLoadedMetadata={(event) =>
					setDuration(
						Number.isFinite(event.currentTarget.duration)
							? event.currentTarget.duration
							: 0,
					)
				}
				onPlay={() => setPlaying(true)}
				onPlaying={() => {
					setPlaying(true);
					setFailed(false);
					setMessage("");
				}}
				onPause={() => setPlaying(false)}
				onEnded={() => setPlaying(false)}
				onError={() => {
					setPlaying(false);
					setFailed(true);
					setMessage("Preview unavailable. Try play again or listen in full.");
				}}
			/>
			<button
				type="button"
				className="preview-play"
				aria-label={playing ? "Pause preview" : "Play preview"}
				onClick={() => void toggle()}
			>
				{playing ? (
					<RiPauseFill size={20} aria-hidden="true" />
				) : (
					<RiPlayFill size={20} aria-hidden="true" />
				)}
			</button>
			<label className="preview-seek">
				<span>{clock(position)}</span>
				<input
					type="range"
					aria-label="Seek preview"
					min={0}
					max={duration || 30}
					step={0.1}
					value={position}
					disabled={!duration}
					onChange={(event) => {
						const next = Number(event.currentTarget.value);
						if (audioRef.current) audioRef.current.currentTime = next;
						setPosition(next);
					}}
				/>
				<span>{duration ? clock(duration) : "0:30"}</span>
			</label>
			<AutoplayToggle checked={autoplay} onChange={onAutoplay} />
			<a
				className="text-link preview-provider"
				href={preview.storeUrl}
				target="_blank"
				rel="noreferrer"
			>
				Apple Music ↗
			</a>
			<output className="preview-message" aria-live="polite">
				{message}
			</output>
		</div>
	);
}
