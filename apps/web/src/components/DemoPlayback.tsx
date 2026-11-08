import { useEffect, useRef, useState } from "react";
import type { TrackCard } from "@sortfm/contracts";
import { Button } from "#ui/components/base/buttons/button";
import { demoPreview } from "../data/demo-catalog";

export function DemoPlayback({ track }: { track: TrackCard }) {
	// Remount the media element on selection changes, so old audio cannot carry
	// on underneath a new card (including Undo and returning from another page).
	return <TrackPreview key={track.trackId} track={track} />;
}
function TrackPreview({ track }: { track: TrackCard }) {
	const preview = demoPreview(track.trackId);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const audio = audioRef.current;
		return () => { audio?.pause(); };
	}, []);
	if (!preview) return <span>Preview unavailable for this song.</span>;
	return (
		<div className="demo-preview flex min-w-0 flex-col gap-2 text-caption-1-regular text-text-secondary">
			<audio
				ref={audioRef}
				controls
				preload="none"
				src={preview.previewUrl}
				aria-label={`Play audio preview of ${track.title} by ${track.artists[0]?.name}`}
				onError={() => setFailed(true)}
				onPlaying={() => setFailed(false)}
				className="h-10 w-full"
			/>
			<div className="flex flex-wrap items-center gap-2">
				<span>Preview provided courtesy of iTunes.</span>
				<a className="text-link" href={preview.storeUrl} target="_blank" rel="noreferrer">Listen in full on Apple Music ↗</a>
			</div>
			{failed && (
				<div role="status" className="flex flex-wrap items-center gap-2 text-text-error-primary">
					<span>This preview couldn’t load. Try again or choose another song.</span>
					<Button variant="secondary" onClick={() => { setFailed(false); audioRef.current?.load(); }}>Retry preview</Button>
				</div>
			)}
		</div>
	);
}
