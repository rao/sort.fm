/** Server-only C2 persistence boundary. D implements; A consumes; root owns changes. */
import type {ExposureInput,SavedTrackInput} from './db';
import type {FeatureVector,FitResponse} from './features';
import type {ListeningContextSnapshot} from './listening-context';
import type {QueuePolicy,ReviewResult,TrackCard} from './schemas';
import type {PolicySelectRequest,PolicyDecision,PolicyAssociationEvent,PolicyFitReceipt,PolicyAssociationReceipt,PolicyReleaseRequest,PolicyReleaseReceipt,PolicyConfig} from './policy';

export type PolicyLibraryRow = {
  track: TrackCard;
  currentStatus: SavedTrackInput['currentStatus'];
  audioFeatures: FeatureVector | null;
  currentDecision: ReviewResult | null;
};
export type ReviewCandidateSnapshot = {
  library: PolicyLibraryRow[];
  eligibleTrackIds: string[];
  /** Common base-eligible count BEFORE active queue reservation exclusions. */
  remaining: number;
  feedbackRevision: number;
  membershipRevision: number;
  /** Latest validated durable C1 fit receipt, or null; never inferred from a revision. */
  fitReceipt: PolicyFitReceipt | null;
};

export type SelectionFence = {userId: string; requestId: string; leaseId: string};
export type SelectionLease = {leaseId: string; leaseUntil: string};
export type SelectionRevisions = {feedbackRevision: number; membershipRevision: number};
export type C1SelectionDraft = {
  kind: 'c1';
  /** Immutable already-scored page, 1..100 unique tracks/exposure IDs. */
  items: ExposureInput[];
};
export type AdaptiveSelectionDraft = {
  kind: 'adaptive';
  /** Cached coverage frozen once beside model inputs, never sent to C1/C2. */
  listeningContext?: ListeningContextSnapshot;
  /** Preserve the caller's existing UI preference across response loss/recovery. */
  queuePolicy: QueuePolicy;
  /** Exactly one selection request/exposure, epsilon_greedy or linucb only.
   * Includes full exact candidates/features/config/seed and pinned C1 modelVersion.
   * Integration requires nonnull modelVersion AND feedbackRevision, even if the
   * wire permits legacy omission. The decision reports its actual revision.
   */
  request: PolicySelectRequest & {modelVersion:string;feedbackRevision:number;config:PolicyConfig & {strategy:'epsilon_greedy'|'linucb'}};
};
export type SelectionDraft = C1SelectionDraft | AdaptiveSelectionDraft;
export type SelectionStatus = 'prepared' | 'published' | 'release_pending' | 'closed' | 'expired';
export type ReservationClosure = 'consumed' | 'skip' | 'undo' | 'abandoned' | 'prefetch_discarded' | 'expiry';
export type ExposureReservation = {
  exposureId: string;
  trackId: string;
  reservedAt: string;
  expiresAt: string;
  status: 'active' | 'closed' | 'expired';
  closedAt: string | null;
  closureReason: ReservationClosure | null;
};
export type PublishedSelection = {
  /** C1 is 1..100 items; adaptive is exactly one, even if queue limit is 20. */
  items: ExposureInput[];
  /** Exact C2 response, not recomputed telemetry. Null on the C1 path. */
  policyDecision: PolicyDecision | null;
  publishedAt: string;
  reservations: ExposureReservation[];
};
export type SelectionIntent = SelectionRevisions & {
  userId: string;
  requestId: string;
  /** Canonical SHA-256 computed by D from validated semantic prepare input.
   * Never trust a caller-supplied fingerprint as an idempotency authorization.
   */
  fingerprint: string;
  draft: SelectionDraft;
  createdAt: string;
  /** Fixed issuance deadline, DB time; no retry/replay/recovery extends it. */
  expiresAt: string;
  status: SelectionStatus;
  /** Active execution fence; not authority to serve an expired publication. */
  lease: SelectionLease | null;
  publication: PublishedSelection | null;
  /** Remaining returned cards may be served only if active, eligible and unconsumed. */
  replayable: boolean;
  /** Active/eligible/unconsumed subset on this read. Publication remains immutable;
   * adapters may serve ONLY these IDs, never all stored items blindly.
   */
  servableExposureIds: string[];
};

export type PrepareSelectionInput = SelectionRevisions & {
  userId: string;
  requestId: string;
  draft: SelectionDraft;
  /** Server config only: 1,000..120,000 ms. Reclaims get a new lease ID. */
  leaseMs: number;
  /** Fixed intent/publication lifetime, 30,000..900,000 ms, starting at prepare.
   * For adaptive selections, published expiry is also <= the actual C2 deadline.
   */
  reservationMs: number;
};
export type PrepareSelectionResult =
  | {outcome: 'claimed'; intent: SelectionIntent & {lease: SelectionLease}}
  | {outcome: 'in_progress'; intent: SelectionIntent}
  | {outcome: 'replay'; intent: SelectionIntent & {publication: PublishedSelection}}
  | {outcome: 'closed'; intent: SelectionIntent};
export type PublishSelectionInput = SelectionFence & (
  | {kind: 'c1'} // exact page already stored in draft
  | {kind: 'adaptive'; item: ExposureInput; decision: PolicyDecision; providerExpiresAt: string}
);
export type PublishSelectionResult =
  | {outcome: 'published' | 'replay'; intent: SelectionIntent & {publication: PublishedSelection}}
  | {outcome: 'rejected'; reason: 'lease_lost' | 'expired' | 'candidates_changed' | 'closed'; intent: SelectionIntent};

export type ReleaseSelectionInput = {
  userId: string;
  /** Background/failed-request abandonment supplies its execution fence. A stale
   * fence cannot close a published page or a newer recovery attempt. */
  expectedLeaseId?: string;
  /** Stable command UUID, distinct from the original selection request UUID. */
  releaseId: string;
  requestId: string;
  /** Subset of the published page, or the adaptive draft's known exposure ID.
   * Never accept another owner's/intent's exposure. Empty arrays are invalid.
   */
  exposureIds: string[];
  reason: 'skip' | 'abandoned' | 'prefetch_discarded';
};
export type SelectionReleaseReceipt = {
  userId: string;
  releaseId: string;
  requestId: string;
  exposureIds: string[];
  reason: ReleaseSelectionInput['reason'];
  recordedAt: string;
  outcome: 'closed' | 'release_pending';
};

export type PolicyDeliveryEvent = {
  userId: string;
  eventId: string;
  /** Separate monotonic per-owner sequence, including release and label-free SKIP. */
  sequence: number;
  createdAt: string;
} & (
  | {kind: 'associate'; event: PolicyAssociationEvent}
  | {kind: 'release'; request: PolicyReleaseRequest}
);
export type PolicyDeliveryLease = {
  event: PolicyDeliveryEvent;
  leaseId: string;
  leaseUntil: string;
  attempts: number;
  /** Association claims require a validated receipt revision >= event revision.
   * A later retry may attach a newer receipt without changing event fingerprint.
   * Release events have null here and require no C1 fit.
   */
  fitReceipt: PolicyFitReceipt | null;
};
export type PolicyDeliveryAck = {userId: string; eventId: string; leaseId: string} & (
  | {kind: 'associate'; receipt: PolicyAssociationReceipt}
  | {kind: 'release'; receipt: PolicyReleaseReceipt}
  /** Local resolution, NOT a provider release receipt or proof of remote closure.
   * Only unpublished adaptive intents after original expiry + fixed 60s grace,
   * with a fresh exact exposure 404 during this live delivery lease. A very late
   * remote commit can still leave a bounded ghost lease; it must never be served
   * or rewarded. Published bindings cannot use this resolution. */
  | {kind:'release_absent';exposureId:string;checkedAt:string;providerStatus:404}
);

export interface PolicyStore {
  /** Reuse the most recent published page instead of allocating another page on
   * each GET/swipe. Owner-locked projection may reconcile expiry. Only returned
   * servableExposureIds may reach the browser; other stored items are history.
   */
  currentSelection(userId: string): Promise<SelectionIntent | null>;

  /** Strict confirmed membership and same predicates for all policies:
   * playable Spotify, saved/deferred, no pending review/Undo, active strong review
   * or effective label, unexpired reservation, or ANY permanent015 assignment.
   * Strong COMPLETE excluded; SKIP reeligible only after closure, UNDONE only
   * after committed restoration. Full current library remains feature context.
   * Advisory snapshot only; publication always rechecks under the owner lock.
   */
  reviewCandidates(userId: string): Promise<ReviewCandidateSnapshot>;

  /** Persist exact request before I/O. Compare revisions and candidate eligibility;
   * one active prepared adaptive intent per owner prevents simultaneous selectors.
   * Same request+payload is replay; differing payload -> IDEMPOTENCY_CONFLICT.
   * Reclaim expired execution lease with a fresh ID, never extend intent expiry.
   * A closed/nonreplayable request never silently becomes a new selection.
   */
  prepareSelection(input: PrepareSelectionInput): Promise<PrepareSelectionResult>;

  /** Atomic exposure+binding+reservation publication under shared owner lock.
   * Recheck eligibility even when both revisions match (pending KEEP/SKIP need
   * not increment them). Verify exact request/candidate/features/pinned C1 and
   * C2 provenance. C1 page all-or-none. No network I/O in transaction.
   * Stale adaptive result becomes release_pending with durable release delivery;
   * never erase it or serve it through fallback. Pure lease_lost must not let
   * an old worker close a newer lease; recovery owns subsequent reconciliation.
   */
  publishSelection(input: PublishSelectionInput): Promise<PublishSelectionResult>;

  /** Claim oldest prepared intent with expired lease and unexpired fixed deadline.
   * Returns exact original request for bounded retry/lookup. Expired intents are
   * terminal for issuance and schedule release, never create fresh remote work.
   * Late recovered results pass the same publish fence and eligibility recheck.
   */
  claimSelectionRecovery(input: {workerId: string; leaseMs: number}): Promise<SelectionIntent | null>;

  /** Close only requested reservations, preserve immutable exposures. Reject replay
   * with different payload. An in-flight adaptive call may still complete:
   * mark release_pending and retain release work until confirmed remote closure
   * or authoritative provider expiry; 404 alone is NOT a successful release.
   * Partial C1-page release leaves other active cards replayable. Neither release
   * nor expiry cancels pending mutation work, changes a label, or adds reward.
   */
  releaseSelection(input: ReleaseSelectionInput): Promise<SelectionReleaseReceipt>;

  /** Oldest unacknowledged sequence per owner, SKIP LOCKED across owners. Never
   * skip an earlier delayed event to deliver a later event for the same owner.
   * Claim only associations whose required C1 revision has a validated fit receipt.
   * DB leases use DB time; bounded retries and worker IDs. No C1-training lockout.
   */
  claimPolicyDelivery(input: {workerId: string; leaseMs: number}): Promise<PolicyDeliveryLease | null>;
  /** Validate receipt identity and semantics against the immutable stored event;
   * exact live lease required. Atomic acknowledgement and release reconciliation.
   * False for stale lease; receipt mismatch is a fixed safe error.
   */
  acknowledgePolicyDelivery(input: PolicyDeliveryAck): Promise<boolean>;
  /** Persist retry schedule + allowlisted safe code; expired/replaced lease -> false.
   * Never log/store remote error bodies. Same event UUID/payload on every retry.
   */
  retryPolicyDelivery(input: {userId: string; eventId: string; leaseId: string; retryAt: string; errorCode: string}): Promise<boolean>;
}

/** Additive Repository signature; existing callers remain source-compatible.
 * Validate FitResponse schema, owner, exact acknowledged revision, nonempty
 * modelVersion and internal response consistency before writing a receipt.
 * Map FitResponse.feedbackRevision to receipt.synchronizedFeedbackRevision.
 * Store receipt and successful acknowledgement in one transaction. Stale lease
 * false -> no receipt write. Numeric-only legacy ack records no fabricated receipt.
 * Missing016 retains existing legacy ack behavior; policy activation/readiness
 * separately requires016. Manual fit stays independent unless explicitly wired.
 */
export interface PolicyAwareFeedbackRepository {
  acknowledgeFeedbackSync(userId: string, leaseId: string, revision: number, receipt?: FitResponse): Promise<boolean>;
  /** Called after the actual shared RepositoryMl.fit resolves, including manual
   * fits whose HTTP caller timed out. Validate owner/schema and actual response;
   * monotonically persist modelVersion + synchronizedFeedbackRevision, reject
   * regressions/conflicting versions/future DB revisions. Exact duplicate is safe.
   * Does NOT acknowledge a feedback job or cause another fit/observe. Missing016
   * returns false. Pending policy delivery never gates C1 training completion.
   */
  recordPolicyFitReceipt(userId: string, receipt: FitResponse): Promise<boolean>;
}

/** Settlement integration is deliberately NOT an arbitrary public enqueue method.
 * Within Repository.settleDecision transaction, a bound purpose=review exposure
 * reaching COMPLETE emits one immutable upsert; UNDONE emits one revoke. Unique
 * (owner,decisionId,operation) plus per-owner sequence. Preserve event UUID on
 * retries; retain history even when /fit coalesces past an event. SKIP has null
 * label and no reward; Undo closes only its original reservation. Calibration
 * and historic unbound/C1 exposures emit no C2 association. Existing feedback
 * revision/snapshot-fit outbox semantics remain unchanged.
 */
