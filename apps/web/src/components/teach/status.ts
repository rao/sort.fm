import type { CalibrationHistory } from "@sortfm/contracts";

// Presentation port agreed with integration. Wire validation lives in the
// integration-owned shared route; no model or Spotify writes belong here.
export type TeachStatus = import("@sortfm/contracts").TeachingStatus;
export type TeachReads = {
	history: () => Promise<CalibrationHistory>;
	status: () => Promise<TeachStatus>;
};
export type TeachingState = {
	status: TeachStatus | null;
	warning: string | null;
};
export function synchronization(
	status: TeachStatus | null,
	confirmedRevision = 0,
) {
	if (!status) return "Synchronization unavailable";
	if (status.feedbackRevision < confirmedRevision)
		return "Refreshing saved feedback";
	if (status.synchronizedFeedbackRevision === null)
		return "Model synchronization not confirmed";
	if (status.synchronizedFeedbackRevision < status.feedbackRevision)
		return "Saved · waiting for model sync";
	return "Feedback synchronized";
}
