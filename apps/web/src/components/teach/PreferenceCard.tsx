import { useRef, useState, type PointerEvent } from "react";
import type {
	CalibrationState,
	CalibrationAction,
} from "../../state/calibration";
import { calibrationActionFromDrag } from "../../state/calibration";
import { Cover, duration, savedDate } from "../ui";
export function PreferenceCard({
	item,
	busy,
	onAction,
	teaching = false,
}: {
	item: CalibrationState["queue"][number];
	busy: boolean;
	teaching?: boolean;
	onAction: (action: CalibrationAction) => void;
}) {
	const ref = useRef<HTMLElement>(null);
	const drag = useRef<{
		id: number;
		x: number;
		y: number;
		dx: number;
		dy: number;
	} | null>(null);
	const [cue, setCue] = useState<CalibrationAction | null>(null);
	function start(event: PointerEvent<HTMLElement>) {
		if (busy || event.button !== 0) return;
		drag.current = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			dx: 0,
			dy: 0,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
	}
	function move(event: PointerEvent<HTMLElement>) {
		const point = drag.current;
		if (!point || point.id !== event.pointerId) return;
		point.dx = event.clientX - point.x;
		point.dy = event.clientY - point.y;
		if (ref.current)
			ref.current.style.transform = `translate(${point.dx}px,${point.dy}px) rotate(${point.dx / 25}deg)`;
		setCue(calibrationActionFromDrag(point.dx, point.dy));
	}
	function end(event: PointerEvent<HTMLElement>, cancelled = false) {
		const point = drag.current;
		if (!point || point.id !== event.pointerId) return;
		drag.current = null;
		setCue(null);
		if (ref.current) ref.current.style.transform = "";
		if (!busy && !cancelled) {
			const action = calibrationActionFromDrag(point.dx, point.dy);
			if (action !== null) onAction(action);
		}
	}
	return (
		<div className="card-stage">
			<article
				className="song-card calibration-card"
				ref={ref}
				aria-label={`${item.track.title} by ${item.track.artists.map((artist) => artist.name).join(", ")}`}
				aria-busy={busy}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={(event) => end(event)}
				onPointerCancel={(event) => end(event, true)}
			>
				<Cover track={item.track} typography className="main-art" />
				{cue !== null && (
					<div
						className={`swipe-cue ${cue === 0 ? "keep" : cue === 1 ? "unlike" : "skip"}`}
					>
						<strong>
							{teaching
								? cue === 0
									? "Keep"
									: cue === 1
										? "Discard"
										: "Unsure"
								: cue === 0
									? "Would keep"
									: cue === 1
										? "Would remove"
										: "Skip"}
						</strong>
						<small>Spotify stays unchanged</small>
					</div>
				)}
				<div className="song-details">
					<div className="song-title-line">
						<h2>{item.track.title}</h2>
						<span className="duration">{duration(item.track.durationMs)}</span>
					</div>
					<p>
						{item.track.artists.map((artist) => artist.name).join(", ")} ·{" "}
						{item.track.album}
					</p>
					<div className="saved-line">
						<span>
							Saved{" "}
							<time dateTime={item.track.originalAddedAt}>
								{savedDate(item.track.originalAddedAt)}
							</time>
						</span>
						<span>
							{item.track.releaseDate?.slice(0, 4) ?? "Release unknown"}
						</span>
					</div>
				</div>
			</article>
		</div>
	);
}
