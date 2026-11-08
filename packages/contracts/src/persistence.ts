// Server-only persistence types: never serialize credential records to the browser.
// Based on A1 d4be70c plus agreed current-membership publication; wire schemas are unchanged.
import type {AccountSession, LibraryImportStatus, ErrorEnvelope} from './schemas';
import type {SavedTrackInput} from './db';

export type Account = {
  user: NonNullable<AccountSession['user']>;
  accessToken: string; refreshToken: string; expiresAt: number; scopes: string[];
  credentialVersion: string; revoked: boolean;
  refreshLease: {id: string; until: number} | null;
};
export type Session = {hash: string; userId: string; expiresAt: number};
export type OAuthAttempt = {stateHash: string; browserHash: string; verifier: string; expiresAt: number};
export type ImportJob = {
  userId: string; progress: LibraryImportStatus;
  lease: {id: string; until: number} | null;
  retryAt: number | null; restart: boolean; restarts: number; pass: number;
  seenIds: string[]; rejected: number; duplicates: number;
  firstPageHash: string | null; sourceTotal: number | null;
  /** Capture before the first provider page; preserve on resume. Null/legacy requires a fresh pass. */
  membershipRevision: number | null;
};
export type ImportObservation = {
  userId: string; jobId: string; pass: number; offset: number; raw: unknown;
  reason: 'null_track' | 'local_track' | 'invalid_track' | 'invalid_timestamp' | null;
  trackId: string | null; observedAt: string;
};
export type ImportMembership = {
  userId: string; jobId: string; pass: number;
  /** Revision captured before this pass; publication atomically compares it under the owner lock. */
  expectedMembershipRevision: number;
  /** Unique successfully normalized members; raw rejected entries remain in observations. */
  trackIds: string[];
  /** Provider-reported total, including entries that could not be normalized. */
  sourceTotal: number; observedAt: string;
};
export type TasteContext = {
  userId: string; fetchedAt: string; source: 'spotify-recently-played';
  completeHistory: false; events: {trackId: string; playedAt: string}[];
  error: ErrorEnvelope | null;
};
export type LibrarySummary = {total: number; reviewed: number; remaining: number; archived: number; unliked: number; kept: number; skipped: number};

/**
 * D integration boundary. Every callback MUST be an atomic, serializable transaction.
 * Reads must be detached values, not shared mutable references. User-scoped keys are
 * mandatory. Throwing rolls back ALL writes. Do not retry callbacks with side effects.
 * No callback in A1 performs network I/O.
 */
export interface A1Transaction {
  getAccount(userId: string): Promise<Account | null>;
  putAccount(account: Account): Promise<void>;
  getSession(hash: string): Promise<Session | null>;
  putSession(session: Session): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  deleteSessions(userId: string): Promise<void>;
  getOAuth(stateHash: string): Promise<OAuthAttempt | null>;
  putOAuth(attempt: OAuthAttempt): Promise<void>;
  deleteOAuth(stateHash: string): Promise<void>;
  getJob(userId: string): Promise<ImportJob | null>;
  putJob(job: ImportJob): Promise<void>;
  /** Monotonic revision of confirmed import/removal/restoration membership, read under the owner lock. */
  getMembershipRevision(userId: string): Promise<number>;
  /** Preserve first originalAddedAt and existing review status on conflict (userId, trackId). */
  upsertSavedTracks(rows: SavedTrackInput[]): Promise<void>;
  /** Idempotent key (userId, jobId, pass, offset); retain raw invalid/local/null entries too. */
  putObservations(rows: ImportObservation[]): Promise<void>;
  /** Replace membership only inside the fenced successful job-completion transaction.
   * Empty completion clears membership; failed/partial scans preserve the prior set.
   * Retain original save dates, review state and all history independently.
   * Reject stale revisions with IMPORT_MEMBERSHIP_CHANGED, and unresolved destructive
   * review/Undo with MEMBERSHIP_MUTATION_PENDING, including work with expired leases.
   * Successful publication and confirmed destructive settlement/Undo each increment
   * the revision atomically. Publication and destructive command creation must share
   * the owner lock so provider IO cannot slip between the guard and publication.
   */
  completeImportMembership(input: ImportMembership): Promise<void>;
  getSummary(userId: string): Promise<LibrarySummary>;
  putTasteContext(context: TasteContext): Promise<void>;
  /** Optional for legacy adapters. Cached detached owner-scoped read; no provider I/O. */
  getTasteContext?(userId: string): Promise<TasteContext | null>;
}
export interface A1Store {
  transaction<T>(work: (tx: A1Transaction) => Promise<T>): Promise<T>;
  /** Pending/running and retryable failed jobs; owner filtering is rechecked by A1. */
  resumableUserIds(): Promise<string[]>;
}
