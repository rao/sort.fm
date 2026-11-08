import type { AccountSession } from "@sortfm/contracts";
import {
	RiMusic2Line,
	RiHeartLine,
	RiFolderMusicLine,
	RiHistoryLine,
	RiEqualizerLine,
	RiHeadphoneLine,
	RiMoonLine,
	RiSunLine,
	RiArrowRightUpLine,
	RiUser3Line,
} from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import { cx } from "#ui/utils/cx";
import { Logo } from "./ui";

const channels = [
	{ path: "review", label: "Sort", Icon: RiMusic2Line },
	{ path: "calibrate", label: "Teach", Icon: RiHeartLine },
	{ path: "dashboard", label: "Library", Icon: RiFolderMusicLine },
	{ path: "history", label: "History", Icon: RiHistoryLine },
	{ path: "model", label: "Model", Icon: RiEqualizerLine },
] as const;
export type DeskRoute =
	| "landing"
	| "review"
	| "calibrate"
	| "dashboard"
	| "library"
	| "history"
	| "model"
	| "insights";
export function MusicDeskChrome({
	route,
	session,
	total,
	remaining,
	night,
	playbackVisible,
	onNight,
	onPlayback,
	onAccount,
}: {
	route: DeskRoute;
	session: AccountSession | null;
	total: number | null;
	remaining: number | null;
	night: boolean;
	playbackVisible: boolean;
	onNight(): void;
	onPlayback(): void;
	onAccount(): void;
}) {
	const live = session?.mode === "spotify";
	const group =
		route === "library" ? "dashboard" : route === "insights" ? "model" : route;
	const channel = channels.find((c) => c.path === group);
	const displayName = live
		? session.user?.displayName || "Spotify listener"
		: "Demo listener";
	const subroutes =
		group === "dashboard"
			? [
					["dashboard", "Overview"],
					["library", "Sync"],
				]
			: group === "model"
				? [
						["model", "Lab"],
						["insights", "Inspector"],
					]
				: [];
	return (
		<>
			<aside className="desk-sidebar">
				<Logo />
				<span className="desk-nav-caption">Pick a channel</span>
				<nav className="desk-channels" aria-label="Workspace navigation">
					{channels.map(({ path, label, Icon }) => (
						<a
							key={path}
							href={`#/${path}`}
							aria-current={group === path ? "page" : undefined}
							className={cx("desk-channel", `desk-channel-${path}`)}
						>
							<span className="desk-channel-icon">
								<Icon size={24} />
							</span>
							<span>{label}</span>
							<i aria-hidden="true" />
						</a>
					))}
				</nav>
				<div className="desk-collection">
					<span>Your collection</span>
					<strong>{total === null ? "—" : total.toLocaleString()}</strong>
					<span>{live ? "liked songs" : "demo songs"}</span>
					<small>
						{remaining === null
							? "Remaining unavailable"
							: `${remaining.toLocaleString()} remaining`}
					</small>
				</div>
				<button
					type="button"
					className="desk-profile"
					onClick={onAccount}
					aria-label="Account and Spotify connection"
				>
					<span className="desk-avatar" aria-hidden="true">
						{displayName.slice(0, 1)}
					</span>
					<span>
						<strong>{displayName}</strong>
						<small>{live ? "Spotify connected" : "Just exploring"}</small>
					</span>
					<RiArrowRightUpLine size={18} />
				</button>
			</aside>
			<header className="desk-topbar">
				<div className="desk-location">
					<span>Music desk</span>
					<i aria-hidden="true">▸</i>
					<strong>{channel?.label ?? "Welcome"}</strong>
				</div>
				<div className="desk-tools">
					<span className="desk-source">
						<i />
						{live ? "SPOTIFY" : "DEMO TAPE"}
					</span>
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={RiUser3Line}
						className="desk-mobile-account"
						aria-label="Account and Spotify connection"
						onClick={onAccount}
					/>
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={RiHeadphoneLine}
						aria-label={
							playbackVisible
								? "Hide playback controls"
								: "Show playback controls"
						}
						aria-pressed={playbackVisible}
						onClick={onPlayback}
					/>
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={night ? RiSunLine : RiMoonLine}
						aria-label={night ? "Switch to day mode" : "Switch to night mode"}
						onClick={onNight}
					/>
				</div>
			</header>
			{!playbackVisible && (live || route !== "calibrate") && (
				<Button
					variant="secondary"
					className="desk-player-restore"
					leadingIcon={RiHeadphoneLine}
					onClick={onPlayback}
				>
					Show player
				</Button>
			)}
			{subroutes.length > 0 && (
				<nav
					className="desk-subnav"
					aria-label={group === "model" ? "Model views" : "Library views"}
				>
					{subroutes.map(([path, label]) => (
						<a
							key={path}
							href={`#/${path}`}
							aria-current={route === path ? "page" : undefined}
						>
							{label}
						</a>
					))}
				</nav>
			)}
		</>
	);
}
