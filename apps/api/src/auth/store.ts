import type {AccountSession, SavedTrackInput, LibraryImportStatus, ErrorEnvelope} from '@sortfm/contracts';

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
};
export type ImportObservation = {
  userId: string; jobId: string; pass: number; offset: number; raw: unknown;
  reason: 'null_track' | 'local_track' | 'invalid_track' | 'invalid_timestamp' | null;
  trackId: string | null; observedAt: string;
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
  /** Preserve first originalAddedAt and existing review status on conflict (userId, trackId). */
  upsertSavedTracks(rows: SavedTrackInput[]): Promise<void>;
  /** Idempotent key (userId, jobId, pass, offset); retain raw invalid/local/null entries too. */
  putObservations(rows: ImportObservation[]): Promise<void>;
  getSummary(userId: string): Promise<LibrarySummary>;
  putTasteContext(context: TasteContext): Promise<void>;
}
export interface A1Store {
  transaction<T>(work: (tx: A1Transaction) => Promise<T>): Promise<T>;
  /** Pending/running and retryable failed jobs; owner filtering is rechecked by A1. */
  resumableUserIds(): Promise<string[]>;
}
