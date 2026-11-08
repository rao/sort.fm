import {
	PUBLIC_ROUTES,
	ErrorEnvelopeSchema,
	ReviewRequestSchema,
	QueueQuerySchema,
	PlayRequestSchema,
	UndoRequestSchema,
	UuidSchema,
	type AccountSession,
	type ModelMetrics,
	type QueueResult,
	type ReviewRequest,
	type ReviewResult,
	type UndoRequest,
} from "@sortfm/contracts";
import { ApiError, createApiClient } from "@sortfm/contracts/client";
import type { ReviewClient } from "./demo-client";

export type LibrarySummary = ReturnType<
	typeof PUBLIC_ROUTES.librarySummary.response.parse
>;
type WireInsightsData = ReturnType<
	typeof PUBLIC_ROUTES.insights.response.parse
>;
// Frontend view only: quarantine model metrics without losing independent audio status.
export type InsightsData = Omit<WireInsightsData, "metrics"> & {
	metrics: ModelMetrics | null;
};
export function isEmptyModelEvaluation(metrics: ModelMetrics): boolean {
	// C1 maps an empty example set to "synthetic" because the shared enum has no
	// "none" value. Accept only its exact no-feedback/no-evaluation combination.
	return (
		metrics.status === "insufficient_data" &&
		metrics.evaluationMethod === "none" &&
		metrics.evaluatedAt === null &&
		[
			metrics.labeledExamples,
			metrics.trainedExamples,
			metrics.heldOutExamples,
			metrics.heldOutPositive,
			metrics.heldOutNegative,
		].every((value) => value === 0) &&
		[
			metrics.baseRate,
			metrics.balancedAccuracy,
			metrics.rocAuc,
			metrics.prAuc,
			metrics.logLoss,
			metrics.brierScore,
			metrics.precisionAtK,
		].every((value) => value === null)
	);
}
export type ImportStatus = ReturnType<
	typeof PUBLIC_ROUTES.syncStatus.response.parse
>;
export type PendingCommand =
	| { kind: "decide"; request: ReviewRequest; terminal?: boolean }
	| {
			kind: "undo";
			decisionId: string;
			request: UndoRequest;
			terminal?: boolean;
	  };
export type LiveSnapshot = {
	session: AccountSession;
	queue: QueueResult;
	summary: LibrarySummary;
	history: ReviewResult[] | null;
	historyHasMore: boolean;
	insights: InsightsData | null;
	warnings: string[];
};
export type LiveReviewSnapshot = Pick<
	LiveSnapshot,
	"session" | "queue" | "summary"
>;
export type LiveDetails = Pick<
	LiveSnapshot,
	"history" | "historyHasMore" | "insights" | "warnings"
>;
export interface Journal {
	read(): PendingCommand | null;
	write(command: PendingCommand): void;
	clear(): void;
}
export interface LiveGateway {
	snapshot(): Promise<LiveSnapshot>;
	reviewSnapshot(): Promise<LiveReviewSnapshot>;
	details(): Promise<LiveDetails>;
	journal: Journal;
	api: LiveApi;
	session: AccountSession;
}
export function pendingJournal(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
	userId: string,
): Journal {
	const key = `sortfm:pending:v1:${encodeURIComponent(userId)}`;
	return {
		read() {
			const raw = storage.getItem(key);
			if (!raw) return null;
			const value = JSON.parse(raw);
			if (value.kind === "decide")
				return {
					kind: "decide",
					request: ReviewRequestSchema.parse(value.request),
					terminal: value.terminal === true,
				};
			if (value.kind === "undo" && typeof value.decisionId === "string")
				return {
					kind: "undo",
					decisionId: UuidSchema.parse(value.decisionId),
					request: UndoRequestSchema.parse(value.request),
					terminal: value.terminal === true,
				};
			throw new Error(
				"The saved command cannot be read. Keep this tab open and reconnect before recovery.",
			);
		},
		write(command) {
			storage.setItem(key, JSON.stringify(command));
		},
		clear() {
			storage.removeItem(key);
		},
	};
}
export function errorMessage(error: unknown) {
	return error instanceof Error
		? error.message
		: "The connection could not be completed.";
}
export function isUnauthorized(error: unknown) {
	return (
		error instanceof ApiError && (error.status === 401 || error.status === 403)
	);
}

export function createLiveApi(
	options: {
		baseUrl?: string;
		fetch?: typeof fetch;
		onUnauthorized?: () => void;
	} = {},
) {
	const base = (options.baseUrl ?? "").replace(/\/$/, "");
	const transport = options.fetch ?? globalThis.fetch;
	// Bounded requests, including writes; writes are never automatically replayed.
	const boundedFetch = (async (input, init) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20_000);
		try {
			const response = await transport(input, {
				...init,
				signal: controller.signal,
			});
			const body = await response.arrayBuffer();
			if (response.status === 401) {
				let playbackReconnect = false;
				if (String(input).startsWith(`${base}/api/player/`)) {
					try {
						const error = ErrorEnvelopeSchema.safeParse(
							JSON.parse(new TextDecoder().decode(body)),
						);
						playbackReconnect =
							error.success &&
							error.data.code === "PLAYBACK_RECONNECT_REQUIRED";
					} catch {
						/* An unreadable 401 still invalidates the primary session. */
					}
				}
				// A separate playback grant can expire while the library login is valid.
				if (!playbackReconnect) options.onUnauthorized?.();
			}
			return new Response(response.status === 204 ? null : body, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
		} finally {
			clearTimeout(timer);
		}
	}) as typeof fetch;
	const shared = createApiClient({ baseUrl: base, fetch: boundedFetch });
	const inFlight = new Map<string, Promise<unknown>>();
	// Deduplicate concurrent reads only. No account data survives this API instance.
	function read<T>(
		key: string,
		operation: () => Promise<T>,
		fresh = false,
	): Promise<T> {
		const existing = !fresh && inFlight.get(key);
		if (existing) return existing as Promise<T>;
		const request = operation()
			.catch(async (error) => {
				if (
					!(error instanceof ApiError) ||
					!error.error.retryable ||
					isUnauthorized(error)
				)
					throw error;
				return operation();
			})
			.finally(() => {
				if (inFlight.get(key) === request) inFlight.delete(key);
			});
		if (!fresh) inFlight.set(key, request);
		return request;
	}
	async function extra<T>(
		route: {
			path: string;
			method: string;
			response: { parse(value: unknown): T };
		},
		body?: unknown,
	): Promise<T> {
		const response = await boundedFetch(`${base}${route.path}`, {
			method: route.method,
			credentials: "include",
			headers: {
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			const error = ErrorEnvelopeSchema.safeParse(payload);
			throw new ApiError(
				response.status,
				error.success
					? error.data
					: {
							code: "INVALID_ERROR_RESPONSE",
							message: "The API returned an unreadable error.",
							retryable: response.status >= 500,
						},
			);
		}
		try {
			return route.response.parse(payload);
		} catch {
			throw new ApiError(502, {
				code: "INVALID_API_RESPONSE",
				message: "The API response does not match the shared contract.",
				retryable: false,
			});
		}
	}
	return {
		...shared,
		queue: (query: Parameters<typeof shared.queue>[0] = {}) => {
			const parsed = QueueQuerySchema.parse(query);
			return read(`queue:${JSON.stringify(parsed)}`, () => shared.queue(parsed));
		},
		authUrl: `${base}${PUBLIC_ROUTES.authStart.path}`,
		session: (options?: { fresh?: boolean }) =>
			read("session", shared.session, options?.fresh),
		summary: () => read("summary", () => extra(PUBLIC_ROUTES.librarySummary)),
		importStatus: () => read("import", () => extra(PUBLIC_ROUTES.syncStatus)),
		startImport: () => extra(PUBLIC_ROUTES.sync),
		logout: () => extra(PUBLIC_ROUTES.logout),
		playerStatus: () => read("player", () => extra(PUBLIC_ROUTES.playerStatus)),
		play: async (trackUri: string) =>
			extra(PUBLIC_ROUTES.play, PlayRequestSchema.parse({ trackUri })),
		retrain: () => extra(PUBLIC_ROUTES.retrain),
		insights: (options?: { fresh?: boolean }) =>
			read("insights", shared.insights, options?.fresh),
		history: (options?: { fresh?: boolean }) =>
			read("history", shared.history, options?.fresh),
	};
}
export type LiveApi = ReturnType<typeof createLiveApi>;

export function createLiveClient(
	api: LiveApi,
	session: AccountSession,
	journal: Journal,
): ReviewClient {
	if (session.mode !== "spotify" || !session.user)
		throw new Error("Connect Spotify to review your library.");
	const ownerId = session.user.id;
	async function assertOwner(write = false) {
		// A prior background read must not authorize a later mutation after an
		// account switch. Check the owner anew at every operation boundary.
		const current = await api.session({ fresh: true });
		if (current.mode !== "spotify" || current.user?.id !== ownerId)
			throw new ApiError(401, {
				code: "SESSION_CHANGED",
				message: "Your account changed. Reconnect before continuing.",
				retryable: false,
			});
		if (
			!current.capabilities.spotifyRead ||
			(write && !current.capabilities.spotifyWrite)
		)
			throw new ApiError(403, {
				code: "CAPABILITY_REQUIRED",
				message: "Reconnect Spotify with the required library permissions.",
				retryable: false,
			});
		return current;
	}
	async function readReview(current: AccountSession): Promise<LiveReviewSnapshot> {
		const [queue, summary] = await Promise.all([
			api.queue({ mode: "spotify", limit: 20, policy: "balanced" }),
			api.summary(),
		]);
		if (
			queue.mode !== "spotify" ||
			queue.items.some(
				(item) =>
					item.track.source !== "spotify" ||
					item.track.trackId.startsWith("demo:"),
			)
		)
			throw new Error("A live queue returned demo data. Review is paused.");
		return { session: current, queue, summary };
	}
	async function readDetails(): Promise<LiveDetails> {
		// These reads may outlive a confirmed command. Never reuse an earlier
		// refresh's in-flight metadata for a newer command or recovery snapshot.
		const [history, insights] = await Promise.all([
			api
				.history({ fresh: true })
				.then((data) => ({ data, error: null }))
				.catch((error) => ({ data: null, error })),
			api
				.insights({ fresh: true })
				.then((data) => ({ data, error: null }))
				.catch((error) => ({ data: null, error })),
		]);
		for (const result of [history, insights])
			if (isUnauthorized(result.error)) throw result.error;
		let safeInsights: InsightsData | null = insights.data;
		if (
			insights.data?.metrics.dataset === "synthetic" &&
			!isEmptyModelEvaluation(insights.data.metrics)
		) {
			safeInsights = { ...insights.data, metrics: null, prediction: null };
			insights.error = new Error(
				"Live insights returned synthetic model metrics. Personal model data is unavailable.",
			);
		}
		if (history.data?.items.some((item) => item.mode !== "spotify"))
			throw new Error("Live history returned demo decisions.");
		return {
			history: history.data?.items ?? null,
			historyHasMore: !!history.data?.nextCursor,
			insights: safeInsights,
			warnings: [
				history.error && `History: ${errorMessage(history.error)}`,
				insights.error && `Model: ${errorMessage(insights.error)}`,
			].filter(Boolean) as string[],
		};
	}
	async function snapshot(): Promise<LiveSnapshot> {
		const current = await assertOwner();
		const [review, details] = await Promise.all([
			readReview(current),
			readDetails(),
		]);
		return { ...review, ...details };
	}
	return {
		live: {
			snapshot,
			reviewSnapshot: async () => readReview(await assertOwner()),
			details: async () => {
				await assertOwner();
				return readDetails();
			},
			journal,
			api,
			session,
		},
		demoBootstrap: async () => {
			throw new Error("Demo bootstrap is not available in a live session.");
		},
		queue: (query) => api.queue({ ...query, mode: "spotify" }),
		history: api.history,
		insights: api.insights,
		async decide(request) {
			if (request.trackId.startsWith("demo:"))
				throw new Error("Fictional songs cannot be sent to Spotify.");
			await assertOwner(
				request.action === "ARCHIVE" || request.action === "UNLIKE",
			);
			const result = await api.decide(request);
			if (result.mode !== "spotify")
				throw new Error("The live decision returned a demo result.");
			return result;
		},
		async undo(id, request) {
			// Keep/Skip Undo needs no Spotify write. The server checks the persisted
			// decision and authorizes any restoration; never infer its action locally.
			await assertOwner();
			const result = await api.undo(id, request);
			if (result.mode !== "spotify")
				throw new Error("The live restoration returned a demo result.");
			return result;
		},
	};
}
