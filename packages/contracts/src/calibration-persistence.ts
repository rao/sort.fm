import type {CalibrationCorrectionRequest, CalibrationHistory, CalibrationLabelRequest, CalibrationLabelResult, TeachingStatus} from "./calibration";
import type {ExposureInput, SavedTrackInput} from "./db";
import type {FeatureVector} from "./features";
import type {ReviewResult, TrackCard, UndoRequest} from "./schemas";

/** Server-only storage discriminator. Existing exposure inserts default to review. */
export type ExposurePurpose = "review" | "calibration";
export type CalibrationLibraryRow = {
  track: TrackCard;
  currentStatus: SavedTrackInput["currentStatus"];
  audioFeatures: FeatureVector | null;
  currentDecision: ReviewResult | null;
};
export type CalibrationCandidateSnapshot = {
  /** Full current imported library for metadata context, not just eligible tracks. */
  library: CalibrationLibraryRow[];
  /** Distinct owned, playable, currently eligible tracks without an active label. */
  eligibleTrackIds: string[];
};
export type CalibrationLabelInput = {
  userId: string; labelId: string; request: CalibrationLabelRequest;
  requestFingerprint: string; createdAt: string;
};
export type CalibrationUndoInput = {
  userId: string; commandId: string; labelId: string; request: UndoRequest;
  requestFingerprint: string; createdAt: string;
};
export type CalibrationCorrectionInput = {
  userId: string; labelId: string; exposureId: string; request: CalibrationCorrectionRequest;
  requestFingerprint: string; createdAt: string;
};

/**
 * D implements; A consumes. Every method is owner-scoped and transactionally atomic.
 * New commands recheck eligibility under the shared owner lock; they never perform
 * provider I/O or create review work. Identical command retries resolve before those
 * checks and return current authoritative state; conflicting payloads return 409.
 * Label/revoke, owner revision and existing feedback-sync outbox update commit
 * together. See docs/integration/calibration.md for precedence and split invariants.
 */
export interface CalibrationStore {
  calibrationCandidates(userId: string): Promise<CalibrationCandidateSnapshot>;
  /** Persists purpose=calibration independently of the unchanged ExposureInput payload. */
  insertCalibrationExposure(input: ExposureInput): Promise<void>;
  createCalibrationLabel(input: CalibrationLabelInput): Promise<CalibrationLabelResult>;
  /** New explicit training preference from an eligible committed Skip. Source review and C2 ledger stay immutable. */
  correctSkippedPreference?(input: CalibrationCorrectionInput): Promise<CalibrationLabelResult>;
  undoCalibrationLabel(input: CalibrationUndoInput): Promise<CalibrationLabelResult>;
  /** Current projected label states, newest created first; never cleanup decisions. */
  calibrationHistory(userId: string): Promise<CalibrationHistory>;
  /** Public ordinary Teach only: excludes every permanent evaluation/holdout identity. Research history remains separate. */
  teachHistory?(userId: string): Promise<CalibrationHistory>;
  teachingStatus?(userId: string): Promise<TeachingStatus>;
}
