import {
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type CSSProperties,
} from "react";
import type { TrackCard } from "@sortfm/contracts";
export type IconName =
	| "arrow"
	| "heart"
	| "archive"
	| "skip"
	| "unlike"
	| "undo"
	| "spark"
	| "library"
	| "clock"
	| "chart"
	| "close"
	| "check"
	| "music"
	| "external"
	| "headphones"
	| "info"
	| "plus";
const paths: Record<IconName, ReactNode> = {
	arrow: (
		<>
			<path d="M5 12h14M13 6l6 6-6 6" />
		</>
	),
	heart: (
		<path d="M20.3 5.7a5.3 5.3 0 0 0-7.5 0l-.8.8-.8-.8a5.3 5.3 0 0 0-7.5 7.5L12 21l8.3-7.8a5.3 5.3 0 0 0 0-7.5Z" />
	),
	archive: (
		<>
			<path d="M4 8h16v12H4zM3 3h18v5H3zM9 12h6" />
		</>
	),
	skip: (
		<>
			<path d="M12 20V4M6 10l6-6 6 6" />
		</>
	),
	unlike: (
		<>
			<path d="M12 4v16M6 14l6 6 6-6" />
		</>
	),
	undo: (
		<>
			<path d="M4 10h10a6 6 0 1 1 0 12M4 10l5-5M4 10l5 5" />
		</>
	),
	spark: (
		<>
			<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z" />
		</>
	),
	library: (
		<>
			<path d="M4 4v16M9 4v16M14 4l6 16" />
		</>
	),
	clock: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</>
	),
	chart: (
		<>
			<path d="M4 19V5M4 19h16M8 15l4-5 4 2 4-7" />
		</>
	),
	close: <path d="m6 6 12 12M6 18 18 6" />,
	check: <path d="m5 12 4 4L19 6" />,
	music: (
		<>
			<path d="M9 18V5l11-2v13M9 8l11-2" />
			<ellipse cx="6" cy="18" rx="3" ry="2" />
			<ellipse cx="17" cy="16" rx="3" ry="2" />
		</>
	),
	external: (
		<>
			<path d="M14 3h7v7M21 3 10 14M10 5H4v15h15v-6" />
		</>
	),
	headphones: (
		<>
			<path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4zM17 12h3v8h-3z" />
		</>
	),
	info: (
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v6M12 7v1" />
		</>
	),
	plus: <path d="M12 5v14M5 12h14" />,
};
export function Icon({
	name,
	size = 20,
	...props
}: {
	name: IconName;
	size?: number;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{paths[name]}
		</svg>
	);
}
export function Logo() {
	return (
		<a className="logo" href="#/" aria-label="sort.fm home">
			<span className="logo-mark" aria-hidden="true">
				<i />
				<i />
				<i />
				<i />
			</span>
			sort<span className="logo-dot">.</span>fm
		</a>
	);
}
export function Cover({
	track,
	className = "",
	typography = false,
}: {
	track: TrackCard;
	className?: string;
	typography?: boolean;
}) {
	const [failed, setFailed] = useState(false);
	const number = Number(track.trackId.split(":")[1]) || 1;
	const index = (number - 1) % 4;
	return (
		<div
			className={`cover cover-${index} ${className}`}
			style={
				{
					"--art-x": index % 2 ? "100%" : "0%",
					"--art-y": index > 1 ? "100%" : "0%",
				} as CSSProperties
			}
		>
			{track.imageUrl && !failed ? (
				<img
					src={track.imageUrl}
					alt={`${track.album} album artwork`}
					draggable={false}
					onError={() => setFailed(true)}
				/>
			) : (
				<span
					className={
						track.source === "synthetic" ? "cover-art" : "cover-placeholder"
					}
					role="img"
					aria-label={
						track.source === "synthetic"
							? `Original demo artwork for ${track.album}`
							: "Album artwork unavailable"
					}
				>
					{track.source !== "synthetic" && <Icon name="music" size={32} />}
				</span>
			)}
			{typography && track.source === "synthetic" && (
				<div className="cover-type" aria-hidden="true">
					<span>{track.artists[0]?.name}</span>
					<strong>{track.album}</strong>
					<span className="cover-edition">
						STEREO / {track.releaseDate?.slice(0, 4)}
					</span>
				</div>
			)}
		</div>
	);
}
export function Modal({
	title,
	children,
	onClose,
}: {
	title: string;
	children: ReactNode;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		dialog?.showModal();
		return () => {
			dialog?.close();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className="modal"
			onCancel={onClose}
			onClick={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
		>
			<div className="modal-inner">
				<button
					type="button"
					className="icon-button modal-close"
					onClick={onClose}
					aria-label="Close dialog"
				>
					<Icon name="close" />
				</button>
				<h2>{title}</h2>
				{children}
			</div>
		</dialog>
	);
}
export function EmptyState({
	icon = "music",
	title,
	children,
}: {
	icon?: IconName;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="empty-state">
			<span className="empty-icon">
				<Icon name={icon} size={28} />
			</span>
			<h2>{title}</h2>
			{children}
		</div>
	);
}
export function Progress({
	value,
	max,
	label,
}: {
	value: number;
	max: number;
	label: string;
}) {
	return <progress aria-label={label} max={Math.max(1, max)} value={value} />;
}
export function duration(ms: number) {
	return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
}
export function savedDate(value: string) {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(value));
}
