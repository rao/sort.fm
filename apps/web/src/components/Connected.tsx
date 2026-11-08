import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountSession } from "@sortfm/contracts";
import App from "../App";
import {
	createLiveApi,
	createLiveClient,
	errorMessage,
	pendingJournal,
	type ImportStatus,
	type LibrarySummary,
	type LiveApi,
} from "../data/live-client";
import { Landing } from "./Landing";
import { EmptyState, Icon, Logo, Progress } from "./ui";

export function ConnectedRoot() {
	const [session, setSession] = useState<AccountSession | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const api = useMemo(
		() =>
			createLiveApi({
				baseUrl: import.meta.env.VITE_API_ORIGIN,
				onUnauthorized: () => {
					setSession(null);
					setError(
						"Your Spotify session expired. Reconnect to continue. Pending decisions keep their original retry keys.",
					);
				},
			}),
		[],
	);
	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setSession(await api.session());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setLoading(false);
		}
	}, [api]);
	useEffect(() => {
		void load();
	}, [load]);
	const client = useMemo(
		() =>
			session?.mode === "spotify" && session.user
				? createLiveClient(
						api,
						session,
						pendingJournal(
							{
								getItem: (key) => window.sessionStorage.getItem(key),
								setItem: (key, value) =>
									window.sessionStorage.setItem(key, value),
								removeItem: (key) => window.sessionStorage.removeItem(key),
							},
							session.user.id,
						),
					)
				: null,
		[api, session],
	);
	const connect = () => window.location.assign(api.authUrl);
	const logout = async () => {
		try {
			await api.logout();
			setSession(null);
			setError(null);
			window.location.hash = "/";
		} catch (cause) {
			setError(errorMessage(cause));
		}
	};
	if (client)
		return (
			<>
				<App
					key={session!.user!.id}
					client={client}
					onConnect={connect}
					onLogout={() => void logout()}
				/>
				{error && (
					<div className="error-toast" role="alert">
						<p>{error}</p>
						<button
							className="button secondary small"
							type="button"
							onClick={() => setError(null)}
						>
							Dismiss
						</button>
					</div>
				)}
			</>
		);
	if (loading)
		return (
			<div className="connection-gate">
				<Logo />
				<EmptyState title="Finding your place in the music">
					<output>Checking your Spotify session…</output>
					<a className="button secondary" href="?mode=demo#/library">
						Explore the demo
					</a>
				</EmptyState>
			</div>
		);
	return (
		<>
			<Landing onConnect={connect} />
			{error && (
				<div className="error-toast" role="alert">
					<div>
						<strong>Connection needs attention</strong>
						<p>{error}</p>
					</div>
					<button
						className="button secondary small"
						type="button"
						onClick={() => void load()}
					>
						Retry connection
					</button>
					<button
						className="button primary small"
						type="button"
						onClick={connect}
					>
						Reconnect Spotify
					</button>
				</div>
			)}
		</>
	);
}

export async function loadLibraryOverview(api: LiveApi) {
	const [status, summary] = await Promise.allSettled([
		api.importStatus(),
		api.summary(),
	]);
	return {
		status: status.status === "fulfilled" ? status.value : null,
		summary: summary.status === "fulfilled" ? summary.value : null,
		error:
			[status, summary]
				.flatMap((result) =>
					result.status === "rejected" ? [errorMessage(result.reason)] : [],
				)
				.join(" · ") || null,
	};
}

export function ConnectedLibrary({
	api,
	onReview,
	onConnect,
}: {
	api: LiveApi;
	onReview: () => void;
	onConnect: () => void;
}) {
	const [status, setStatus] = useState<ImportStatus | null>(null);
	const [summary, setSummary] = useState<LibrarySummary | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const active = status?.status === "pending" || status?.status === "running";
	// biome-ignore lint/correctness/useExhaustiveDependencies: revision restarts polling after an explicit retry or import.
	useEffect(() => {
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			try {
				const result = await loadLibraryOverview(api);
				if (disposed) return;
				if (result.status) setStatus(result.status);
				if (result.summary) setSummary(result.summary);
				setError(result.error);
				if (
					result.status?.status === "pending" ||
					result.status?.status === "running"
				)
					timer = setTimeout(() => void poll(), 1500);
			} catch (cause) {
				if (!disposed) setError(errorMessage(cause));
			}
		}
		void poll();
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	}, [api, revision]);
	const start = async () => {
		if (busy || active) return;
		setBusy(true);
		setError(null);
		try {
			setStatus(await api.startImport());
			setRevision((value) => value + 1);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="page library-page">
			<header className="page-heading">
				<span className="eyebrow">YOUR SPOTIFY LIBRARY</span>
				<h1>Your music, coming into focus.</h1>
				<p>
					Import your Liked Songs. Then make a little room for what moves you.
				</p>
			</header>
			<div className="import-layout">
				<section className="library-collection connected-collection">
					<div className="connected-library-symbol">
						<Icon name="library" size={72} />
					</div>
					<div className="collection-copy">
						<span className="eyebrow">CONNECTED COLLECTION</span>
						<h2>
							{summary
								? `${summary.total.toLocaleString()} liked songs.`
								: "Your next chapter starts here."}
						</h2>
						<p>
							{summary
								? `${summary.remaining.toLocaleString()} available to review. Counts reflect the latest confirmed library snapshot.`
								: "No review decisions are made during import."}
						</p>
						<span className="subtle-tag">
							<Icon name="check" size={14} />
							Authenticated Spotify session
						</span>
					</div>
				</section>
				<section className="import-panel">
					<h2>
						{active
							? "Bringing your library together"
							: status?.status === "complete"
								? "Your library is ready"
								: "Start with your Liked Songs"}
					</h2>
					<div className="import-stage">
						<span className={`stage-icon ${active ? "spinning" : ""}`}>
							<Icon
								name={status?.status === "complete" ? "check" : "library"}
							/>
						</span>
						<div>
							<strong>
								{status ? `Import ${status.status}` : "Reading import status…"}
							</strong>
							<p aria-live="polite">
								{status
									? `${status.processed.toLocaleString()} processed${status.total === null ? "" : ` of ${status.total.toLocaleString()}`} · ${status.failed} unavailable`
									: "Connecting to the library service"}
							</p>
						</div>
					</div>
					{status?.total != null ? (
						<Progress
							key={status.jobId}
							smooth
							value={status.processed}
							max={status.total || 1}
							label="Spotify import progress"
						/>
					) : active ? (
						<output>Waiting for Spotify's library total…</output>
					) : null}
					{(error || status?.error) && (
						<div className="inline-error" role="alert">
							<p>{error ?? status?.error?.message}</p>
							<button
								className="button secondary"
								type="button"
								onClick={() => setRevision((v) => v + 1)}
							>
								Refresh import status
							</button>
							<button type="button" className="text-button" onClick={onConnect}>
								Reconnect Spotify
							</button>
						</div>
					)}
					{!active && (
						<button
							type="button"
							className="button secondary wide"
							disabled={busy || !status}
							onClick={() => void start()}
						>
							{busy
								? "Starting import…"
								: status?.status === "idle"
									? "Import Liked Songs"
									: status?.status === "failed"
										? "Retry import"
										: "Sync Liked Songs again"}
						</button>
					)}
					{summary && summary.remaining > 0 && !active && (
						<button
							className="button primary wide"
							type="button"
							onClick={onReview}
						>
							Start sorting <Icon name="arrow" size={17} />
						</button>
					)}
					{status?.status === "complete" && summary?.remaining === 0 && (
						<p className="fine-print">
							No songs are waiting for review. You can revisit saved decisions
							in History or sync again.
						</p>
					)}
					{status?.status === "complete" && (
						<a className="button secondary wide" href="#/calibrate">
							Teach your taste · labels only
						</a>
					)}
					<p className="fine-print">
						Import reads your library. Archive and Unlike only change Spotify
						after you choose them in review. Audio enrichment can continue
						separately.
					</p>
				</section>
			</div>
		</div>
	);
}
