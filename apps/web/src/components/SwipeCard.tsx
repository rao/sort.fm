import { useEffect, useRef, useState, type PointerEvent } from "react";
import type { ReviewAction } from "@sortfm/contracts";
import { actionFromDrag, actionLabels, type QueueItem } from "../state/review";
import { Cover, Icon, duration, savedDate, type IconName } from "./ui";
import {
	RiArchiveLine,
	RiArrowUpLine,
	RiHeartLine,
	RiSubtractLine,
} from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import { cx } from "#ui/utils/cx";

const actionStyles = {
	ARCHIVE: { icon: RiArchiveLine, color: "text-review-archive" },
	UNLIKE: { icon: RiSubtractLine, color: "text-review-unlike" },
	SKIP: { icon: RiArrowUpLine, color: "text-review-skip" },
	KEEP: { icon: RiHeartLine, color: "text-button-primary-foreground" },
} as const;
const icons: Record<ReviewAction, IconName> = {
	KEEP: "heart",
	ARCHIVE: "archive",
	SKIP: "skip",
	UNLIKE: "unlike",
};
const keys: Record<ReviewAction, string> = {
	KEEP: "→",
	ARCHIVE: "←",
	SKIP: "↑",
	UNLIKE: "↓",
};
export function ActionButtons({
	disabled,
	canRemove = true,
	onAction,
}: {
	disabled: boolean;
	canRemove?: boolean;
	onAction: (action: ReviewAction) => void;
}) {
	return (
		<fieldset
			className="mt-6 grid min-w-0 grid-cols-4 gap-2 border-0 p-0 sm:gap-3"
			aria-label="Song decisions"
		>
			{(["ARCHIVE", "UNLIKE", "SKIP", "KEEP"] as const).map((action) => (
				<div key={action} className="flex min-w-0 flex-col items-center gap-2">
					<Button
						variant={action === "KEEP" ? "primary" : "secondary"}
						leadingIcon={actionStyles[action].icon}
						disabled={
							disabled ||
							(!canRemove && (action === "ARCHIVE" || action === "UNLIKE"))
						}
						className={cx(
							"h-16 w-full flex-col gap-1 px-0 text-caption-1-semibold sm:px-1",
							actionStyles[action].color,
						)}
						onClick={() => onAction(action)}
						aria-label={`${actionLabels[action]} song (${keys[action]})`}
						aria-keyshortcuts={
							{
								KEEP: "ArrowRight",
								ARCHIVE: "ArrowLeft",
								SKIP: "ArrowUp",
								UNLIKE: "ArrowDown",
							}[action]
						}
					>
						{actionLabels[action]}
					</Button>
					<span
						aria-hidden="true"
						className="text-caption-2-medium text-text-tertiary"
					>
						{keys[action]}
					</span>
				</div>
			))}
		</fieldset>
	);
}

export function SwipeCard({
	item,
	next,
	busy,
	departure,
	onAction,
}: {
	item: QueueItem;
	next?: QueueItem;
	busy: boolean;
	departure: ReviewAction | null;
	onAction: (action: ReviewAction) => void;
}) {
	const ref = useRef<HTMLElement>(null);
	const drag = useRef<{
		id: number;
		x: number;
		y: number;
		dx: number;
		dy: number;
	} | null>(null);
	const spring = useRef<number>(0);
	const [cue, setCue] = useState<ReviewAction | null>(null);
	const [dragging, setDragging] = useState(false);
	useEffect(() => () => cancelAnimationFrame(spring.current), []);
	function transform(x: number, y: number) {
		if (ref.current)
			ref.current.style.transform = `translate3d(${x}px,${y}px,0) rotate(${x / 25}deg)`;
	}
	function returnHome(x: number, y: number) {
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			transform(0, 0);
			return;
		}
		let vx = 0;
		let vy = 0;
		let previous = performance.now();
		function tick(now: number) {
			const dt = Math.min((now - previous) / 1000, 0.025);
			previous = now;
			vx += (-260 * x - 24 * vx) * dt;
			vy += (-260 * y - 24 * vy) * dt;
			x += vx * dt;
			y += vy * dt;
			transform(x, y);
			if (Math.abs(x) + Math.abs(y) + Math.abs(vx) + Math.abs(vy) > 0.5)
				spring.current = requestAnimationFrame(tick);
			else transform(0, 0);
		}
		spring.current = requestAnimationFrame(tick);
	}
	function start(event: PointerEvent<HTMLElement>) {
		if (
			busy ||
			event.button !== 0 ||
			(event.target as Element).closest("a,button")
		)
			return;
		cancelAnimationFrame(spring.current);
		drag.current = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			dx: 0,
			dy: 0,
		};
		event.currentTarget.setPointerCapture(event.pointerId);
		setDragging(true);
	}
	function move(event: PointerEvent<HTMLElement>) {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		current.dx = event.clientX - current.x;
		current.dy = event.clientY - current.y;
		transform(current.dx, current.dy);
		setCue(actionFromDrag(current.dx, current.dy));
	}
	function end(event: PointerEvent<HTMLElement>, cancelled = false) {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = null;
		setDragging(false);
		setCue(null);
		const action = cancelled ? null : actionFromDrag(current.dx, current.dy);
		returnHome(current.dx, current.dy);
		if (action) onAction(action);
	}
	return (
		<div className="card-stage">
			{next && (
				<div className="stack-peek" aria-hidden="true">
					<Cover track={next.track} />
				</div>
			)}
			<article
				ref={ref}
				className={`song-card ${dragging ? "dragging" : ""} ${departure ? `depart-${departure.toLowerCase()}` : ""}`}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={(event) => end(event)}
				onPointerCancel={(event) => end(event, true)}
				aria-label={`${item.track.title} by ${item.track.artists.map((artist) => artist.name).join(", ")}`}
				aria-busy={busy}
			>
				<Cover track={item.track} typography className="main-art" />
				{cue && (
					<div className={`swipe-cue ${cue.toLowerCase()}`}>
						<Icon name={icons[cue]} size={30} />
						<strong>{actionLabels[cue]}</strong>
						{cue === "UNLIKE" && <small>Remove without archiving</small>}
					</div>
				)}
				<div className="song-details">
					<div className="song-title-line">
						<h2>{item.track.title}</h2>
						<span className="duration">{duration(item.track.durationMs)}</span>
					</div>
					<p>
						{item.track.artists.map((artist) => artist.name).join(", ")}{" "}
						<span>•</span> {item.track.album}
					</p>
					<div className="saved-line">
						<span>
							<Icon name="heart" size={13} /> Saved{" "}
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
