// Compatibility boundary for A1 callers; D and A1 share the integration-owned types.
// Server-only records: credentials must never be serialized as public AccountSession.
export type {
  Account, Session, OAuthAttempt, ImportJob, ImportObservation, ImportMembership,
  TasteContext, LibrarySummary, A1Transaction, A1Store,
} from '@sortfm/contracts';
