import type {PlaybackControlScope,PlaybackReturnTo,PlaybackSdkScope} from './playback';

/** Server-only. None of these records is a browser DTO. Timestamps are epoch ms. */
export type PlaybackGrantPurpose='sdk'|'control';
export type PlaybackSessionContext={ownerId:string;initiatingSessionHash:string;now:number};
export type PlaybackOAuthAttempt={
 stateHash:string;purpose:PlaybackGrantPurpose;ownerId:string;initiatingSessionHash:string;
 browserHash:string;encryptedVerifier:string;returnTo:PlaybackReturnTo;createdAt:number;expiresAt:number;
 /** Capture under the same owner lock as insertion; null means no previous grant. */
 expectedCredentialVersion:string|null;
};
export type PlaybackRefreshLease={id:string;until:number;initiatingSessionHash:string};
type GrantCredentials={
 ownerId:string;encryptedAccessToken:string;encryptedRefreshToken:string;expiresAt:number;
 credentialVersion:string;revoked:boolean;refreshLease:PlaybackRefreshLease|null;
};
/** Scope arrays are additionally validated by the corresponding exact-set schema. */
export type PlaybackGrant=GrantCredentials&(
 {purpose:'sdk';scopes:PlaybackSdkScope[]}|{purpose:'control';scopes:PlaybackControlScope[]}
);
export type PlaybackGrantKey={ownerId:string;purpose:PlaybackGrantPurpose};
export type PlaybackRefreshFence=PlaybackSessionContext&PlaybackGrantKey&{expectedCredentialVersion:string;leaseId:string};

/**
 * A1 supplies cryptography/provider I/O; D supplies migration014 and these methods.
 * Every method is atomic under the owner lock, returns detached records, and does
 * no network I/O. All session-context methods validate a live primary session
 * owned by ownerId and a non-revoked primary account in the same transaction.
 * The session hash is server-derived. Logout/primary re-login must fence pending
 * OAuth/refresh completion and future issuance; no primary credentials are changed.
 */
export interface PlaybackStore {
 /** Insert only: no upsert of an existing stateHash. Also compare expected grant version.
  * Namespace state as playback-sdk.<nonce> or playback-control.<nonce>; hash the full
  * state. Unique stateHash spans BOTH playback purposes. Never reuse library state.
  */
 createOAuth(attempt:PlaybackOAuthAttempt,now:number):Promise<void>;
 /** Atomic single-use claim, checking purpose/browser/session/expiry before return.
  * Retain a consumed marker until expiry so callbacks cannot exchange the code twice.
  * Consume even when the provider denied consent; invalid evidence must not consume.
  */
 consumeOAuth(input:PlaybackSessionContext&{stateHash:string;purpose:PlaybackGrantPurpose;browserHash:string}):Promise<PlaybackOAuthAttempt>;
 /** Publish once from the consumed attempt, only while its original session is live.
  * Check stored owner/purpose/session, attempt expiry, and expectedCredentialVersion;
  * grant must match owner/purpose and have a new version and no refresh lease.
  * Return false for missing/expired/already-completed/superseded attempts; never overwrite newer grants.
  */
 completeOAuth(input:PlaybackSessionContext&{stateHash:string;grant:PlaybackGrant}):Promise<boolean>;
 getGrant(input:PlaybackSessionContext&{purpose:PlaybackGrantPurpose}):Promise<PlaybackGrant|null>;
 /** Claim only the expected non-revoked version and an absent/expired lease.
  * The lease belongs to this initiating session; until must be later than now.
  */
 claimRefresh(input:PlaybackRefreshFence&{leaseUntil:number}):Promise<PlaybackGrant|null>;
 /** CAS requires matching unexpired lease, version, purpose, owner, live session.
  * The replacement is non-revoked with a fresh version, exact validated scopes and no lease.
  */
 completeRefresh(input:PlaybackRefreshFence&{grant:PlaybackGrant}):Promise<boolean>;
 /** CAS release never clears a different version/lease. No provider retry here. */
 releaseRefresh(input:PlaybackRefreshFence):Promise<boolean>;
 /** Revocation clears only this grant's encrypted credentials and refresh lease.
  * A rejected refresh must include its leaseId so it cannot revoke newer consent.
  * Does not revoke the primary login, another purpose, or already issued bearers.
  */
 revokeGrant(input:PlaybackGrantKey&{expectedCredentialVersion:string;leaseId?:string;now:number}):Promise<boolean>;
}
