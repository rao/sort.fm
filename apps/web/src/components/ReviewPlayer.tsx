import {
	RiArchiveLine,
	RiArrowUpLine,
	RiHeartLine,
	RiThumbDownLine,
	RiArrowGoBackLine,
	RiEqualizerLine,
	RiHeadphoneLine,
} from "@remixicon/react";
import type { ReviewAction } from "@sortfm/contracts";
import type { ReviewState } from "../state/review";
import { Button } from "#ui/components/base/buttons/button";
import { SwipeCard } from "./SwipeCard";

export function ReviewUndo({
	state,
	onUndo,
	iconOnly = false,
}: {
	state: ReviewState;
	onUndo(id: string): void;
	iconOnly?: boolean;
}) {
	const latest = state.history.find(({ result }) => result.canUndo);
	const locked =
		state.busy ||
		state.loading ||
		state.retraining ||
		!!state.retry ||
		state.refreshing ||
		!!state.refreshError;
	return (
		<Button
			variant="secondary"
			iconOnly={iconOnly}
			leadingIcon={RiArrowGoBackLine}
			className="desk-undo"
			aria-label="Undo latest decision"
			disabled={!latest || locked}
			onClick={() => latest && onUndo(latest.result.decisionId)}
		>
			{iconOnly ? null : "Undo latest decision"}
		</Button>
	);
}

const choices = [
	{
		action: "ARCHIVE",
		label: "Archive",
		key: "←",
		shortcut: "ArrowLeft",
		Icon: RiArchiveLine,
	},
	{
		action: "UNLIKE",
		label: "Unlike",
		key: "↓",
		shortcut: "ArrowDown",
		Icon: RiThumbDownLine,
	},
	{
		action: "SKIP",
		label: "Skip",
		key: "↑",
		shortcut: "ArrowUp",
		Icon: RiArrowUpLine,
	},
	{
		action: "KEEP",
		label: "Keep",
		key: "→",
		shortcut: "ArrowRight",
		Icon: RiHeartLine,
	},
] as const;
export function ReviewPlayer({
	state,
	canRemove,
	showDetails,
	onAction,
	onUndo,
	onDetails,
	onListen,
	onShortcuts,
}: {
	state: ReviewState;
	canRemove: boolean;
	showDetails: boolean;
	onAction(action: ReviewAction): void;
	onUndo(id: string): void;
	onDetails(): void;
	onListen(): void;
	onShortcuts(): void;
}) {
	const current = state.queue[0];
	if (!current) return null;
	const locked =
		state.busy ||
		state.loading ||
		state.retraining ||
		!!state.retry ||
		state.refreshing ||
		!!state.refreshError;
	return (
		<section className="desk-review" aria-label="Review songs">
			<div className="desk-device">
				<div className="desk-device-label">
					<strong>sort.fm</strong>
					<span>Personal music sorter · 01</span>
					<i aria-hidden="true" />
				</div>
				<div className="desk-lcd">
					<div className="desk-lcd-status">
						<span>
							<i />
							Now sorting
						</span>
						<span>{state.queue.length} loaded</span>
					</div>
					<SwipeCard
						key={current.track.trackId}
						item={current}
						next={state.queue[1]}
						busy={locked}
						departure={state.departure}
						onAction={onAction}
					/>
				</div>
				<div className="desk-device-controls">
					<div className="desk-device-side">
						<ReviewUndo state={state} onUndo={onUndo} iconOnly />
						<span>Undo</span>
					</div>
					<fieldset className="desk-wheel" aria-label="Song decisions">
						{choices.map(({ action, label, key, shortcut, Icon }) => (
							<Button
								key={action}
								variant="secondary"
								className={`desk-choice desk-choice-${action.toLowerCase()}`}
								leadingIcon={Icon}
								aria-label={`${label} song (${key})`}
								aria-keyshortcuts={shortcut}
								disabled={
									locked ||
									(!canRemove && (action === "ARCHIVE" || action === "UNLIKE"))
								}
								onClick={() => onAction(action)}
							>
								<span>{label}</span>
							</Button>
						))}
						<Button
							variant="secondary"
							iconOnly
							leadingIcon={RiHeadphoneLine}
							className="desk-listen"
							aria-label="Show playback controls for this song"
							onClick={onListen}
						/>
					</fieldset>
					<div className="desk-device-side">
						<Button
							variant="secondary"
							iconOnly
							leadingIcon={RiEqualizerLine}
							aria-label={
								showDetails
									? "Hide model and context panels"
									: "Show model and context panels"
							}
							aria-pressed={showDetails}
							onClick={onDetails}
						/>
						<span>Details</span>
					</div>
				</div>
				<div className="desk-device-footer">
					<span>
						{state.busy
							? "Saving your choice…"
							: "Drag the sleeve. Follow your instinct."}
					</span>
					<button
						type="button"
						className="text-button"
						aria-label="Keyboard shortcuts"
						onClick={onShortcuts}
					>
						⌨ Shortcuts
					</button>
				</div>
			</div>
			<p className="desk-action-note">
				Archive keeps a playlist copy before unliking. Unlike removes directly.
			</p>
			{!canRemove && (
				<p className="desk-read-only">
					Read-only session. Reconnect Spotify with library write access to
					Archive or Unlike.
				</p>
			)}
		</section>
	);
}
