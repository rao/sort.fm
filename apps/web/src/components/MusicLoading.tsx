import type { ReactNode } from "react";
import { cx } from "#ui/utils/cx";
import "../styles/music-loading.css";

/** Shared indeterminate loader. Real import progress and recovery stay with their owners. */
export function MusicLoading({
	message = "Getting your music ready.",
	compact = false,
	children,
}: {
	message?: string;
	compact?: boolean;
	children?: ReactNode;
}) {
	return (
		<div className={cx("music-loading", compact && "music-loading-compact")}>
			<div className="music-loading-equalizer" aria-hidden="true">
				{[0, 1, 2, 3, 4, 5, 6].map((bar) => (
					<i key={bar} />
				))}
			</div>
			<output className="music-loading-status" aria-live="polite">
				<span className="music-loading-title">
					Tuning in<span aria-hidden="true">…</span>
				</span>
				<span className="music-loading-message">{message}</span>
			</output>
			{children && <div className="music-loading-actions">{children}</div>}
		</div>
	);
}
