import {
	CalibrationCorrectionRequestSchema,
	UndoRequestSchema,
	UuidSchema,
	SpotifyTrackIdSchema,
	type AccountSession,
	type CalibrationCorrectionRequest,
	type UndoRequest,
} from "@sortfm/contracts";
import { ApiError } from "@sortfm/contracts/client";
import type { LiveApi } from "./live-client";

export type CorrectionCommand =
	| { kind: "correct"; trackId: string; request: CalibrationCorrectionRequest }
	| { kind: "undo"; trackId: string; labelId: string; request: UndoRequest };
export interface CorrectionJournal {
	read(): CorrectionCommand | null;
	write(command: CorrectionCommand): void;
	clear(): void;
}
export function correctionJournal(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
	ownerId: string,
): CorrectionJournal {
	// Keep unfinished corrections independent of review and saved-batch journals.
	const key = `sortfm:calibration:correction:pending:v1:${encodeURIComponent(ownerId)}`;
	return {
		read() {
			const raw = storage.getItem(key);
			if (!raw) return null;
			const value = JSON.parse(raw);
			const trackId = SpotifyTrackIdSchema.parse(value.trackId);
			if (value.kind === "correct")
				return {
					kind: "correct",
					trackId,
					request: CalibrationCorrectionRequestSchema.parse(value.request),
				};
			if (value.kind === "undo")
				return {
					kind: "undo",
					trackId,
					labelId: UuidSchema.parse(value.labelId),
					request: UndoRequestSchema.parse(value.request),
				};
			throw new Error(
				"The saved preference command is unreadable. Corrections are paused for recovery.",
			);
		},
		write: (command) => storage.setItem(key, JSON.stringify(command)),
		clear: () => storage.removeItem(key),
	};
}
type CorrectionApi = Pick<
	LiveApi,
	"session" | "calibrationCorrection" | "calibrationHistory" | "calibrationUndo"
>;
export function createCorrectionClient(
	api: CorrectionApi,
	session: AccountSession,
	journal: CorrectionJournal,
) {
	if (session.mode !== "spotify" || !session.user)
		throw new Error("Connect Spotify before saving a preference correction.");
	const ownerId = session.user.id;
	async function assertOwner() {
		const current = await api.session({ fresh: true });
		if (current.mode !== "spotify" || current.user?.id !== ownerId)
			throw new ApiError(401, {
				code: "SESSION_CHANGED",
				message: "Your account changed. Reconnect before saving a preference.",
				retryable: false,
			});
	}
	return {
		journal,
		async history() {
			await assertOwner();
			const history = await api.calibrationHistory();
			await assertOwner();
			return history;
		},
		async correct(request: CalibrationCorrectionRequest) {
			await assertOwner();
			const result = await api.calibrationCorrection(request);
			await assertOwner();
			return result;
		},
		async undo(labelId: string, request: UndoRequest) {
			await assertOwner();
			const result = await api.calibrationUndo(labelId, request);
			await assertOwner();
			return result;
		},
	};
}
export type CorrectionClient = ReturnType<typeof createCorrectionClient>;
