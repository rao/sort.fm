import {
	CalibrationLabelRequestSchema,
	UndoRequestSchema,
	UuidSchema,
	type AccountSession,
	type CalibrationLabelRequest,
	type UndoRequest,
	type ModelMetrics,
} from "@sortfm/contracts";
import { ApiError } from "@sortfm/contracts/client";
import {
	errorMessage,
	isEmptyModelEvaluation,
	isUnauthorized,
	type LiveApi,
} from "./live-client";
export type CalibrationCommand =
	| { kind: "label"; request: CalibrationLabelRequest }
	| { kind: "undo"; labelId: string; request: UndoRequest };
export interface CalibrationJournal {
	read(): CalibrationCommand | null;
	write(command: CalibrationCommand): void;
	clear(): void;
}
export function calibrationJournal(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
	ownerId: string,
): CalibrationJournal {
	const key = `sortfm:calibration:pending:v1:${encodeURIComponent(ownerId)}`;
	return {
		read() {
			const raw = storage.getItem(key);
			if (!raw) return null;
			const value = JSON.parse(raw);
			if (value.kind === "label")
				return {
					kind: "label",
					request: CalibrationLabelRequestSchema.parse(value.request),
				};
			if (value.kind === "undo")
				return {
					kind: "undo",
					labelId: UuidSchema.parse(value.labelId),
					request: UndoRequestSchema.parse(value.request),
				};
			throw new Error(
				"The saved calibration command is unreadable. Labeling is paused for recovery.",
			);
		},
		write: (command) => storage.setItem(key, JSON.stringify(command)),
		clear: () => storage.removeItem(key),
	};
}
// Deliberately exclude every cleanup and player mutation method from this boundary.
type CalibrationApi = Pick<
	LiveApi,
	| "session"
	| "calibrationQueue"
	| "calibrationLabel"
	| "calibrationUndo"
	| "calibrationHistory"
	| "insights"
	| "retrain"
>;
export function createCalibrationClient(
	api: CalibrationApi,
	session: AccountSession,
	journal: CalibrationJournal,
) {
	if (session.mode !== "spotify" || !session.user)
		throw new Error("Connect Spotify to label your imported songs.");
	const ownerId = session.user.id;
	async function assertOwner() {
		const current = await api.session();
		if (current.mode !== "spotify" || current.user?.id !== ownerId)
			throw new ApiError(401, {
				code: "SESSION_CHANGED",
				message: "Your account changed. Reconnect before labeling.",
				retryable: false,
			});
		return current;
	}
	return {
		ownerId,
		journal,
		async snapshot() {
			await assertOwner();
			const [queue, history, model] = await Promise.all([
				api.calibrationQueue({ limit: 20 }),
				api.calibrationHistory(),
				api
					.insights()
					.then((data) => ({ data, error: null }))
					.catch((error: unknown) => ({ data: null, error })),
			]);
			if (isUnauthorized(model.error)) throw model.error;
			await assertOwner();
			let metrics: ModelMetrics | null | undefined = model.data?.metrics;
			let warning = model.error
				? `Model data unavailable: ${errorMessage(model.error)}`
				: null;
			if (
				metrics?.dataset === "synthetic" &&
				!isEmptyModelEvaluation(metrics)
			) {
				metrics = null;
				warning =
					"Synthetic model metrics were excluded from your personal model.";
			}
			return { queue, history, metrics, warning };
		},
		async label(request: CalibrationLabelRequest) {
			await assertOwner();
			return api.calibrationLabel(request);
		},
		async undo(labelId: string, request: UndoRequest) {
			await assertOwner();
			return api.calibrationUndo(labelId, request);
		},
		async retrain() {
			await assertOwner();
			const result = await api.retrain();
			await assertOwner();
			if (
				result.userId !== ownerId ||
				result.modelVersion !== result.metrics.modelVersion ||
				result.trainedExamples !== result.metrics.trainedExamples ||
				(result.metrics.dataset === "synthetic" &&
					!isEmptyModelEvaluation(result.metrics))
			)
				throw new Error(
					"The fit result does not match this account or model. Refresh model data before another fit.",
				);
			return result;
		},
	};
}
export type CalibrationClient = ReturnType<typeof createCalibrationClient>;
