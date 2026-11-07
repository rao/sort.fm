import {z} from 'zod';
import {IdSchema, HttpUrlSchema, type AccountSession} from '@sortfm/contracts';
import type {SpotifyConfig} from './config';
import type {A1Store, Account} from './store';
import {TokenCipher, digest, equalSecret, newSecret, pkceChallenge, sessionHash} from './crypto';
import {SpotifyHttp} from '../spotify/http';
import {authenticationRequired, SpotifyError} from '../spotify/errors';

const tokenSchema = z.object({access_token:z.string().min(1), token_type:z.string().refine(x => x.toLowerCase() === 'bearer'), expires_in:z.number().int().positive(), refresh_token:z.string().min(1).optional(), scope:z.string().optional()});
const profileSchema = z.object({id:IdSchema, display_name:z.string().nullable().optional(), images:z.array(z.object({url:z.string()})).optional()});
export type AccessCredential = {token: string; version: string};

export class AuthService {
  private readonly cipher: TokenCipher;
  constructor(readonly config: SpotifyConfig, readonly store: A1Store, readonly http: SpotifyHttp) {this.cipher = new TokenCipher(config.encryptionKey);}
  assertOwner(account: Account) {
    if (!account.user.spotifyId || !this.config.allowedUserIds.has(account.user.spotifyId) || account.user.id !== `spotify:${account.user.spotifyId}`) throw new SpotifyError('ACCOUNT_NOT_ALLOWED', 'This Spotify account is not authorized for sort.fm.', 403);
    if (account.revoked) throw authenticationRequired();
  }
  async start() {
    const state = newSecret(), browserToken = newSecret(), verifier = newSecret(), stateHash = digest(state);
    await this.store.transaction(tx => tx.putOAuth({stateHash, browserHash:digest(browserToken), verifier:this.cipher.seal(verifier, `oauth:${stateHash}`), expiresAt:this.http.now() + this.config.oauthTtlMs}));
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({response_type:'code', client_id:this.config.clientId, redirect_uri:this.config.redirectUri, scope:this.config.scopes.join(' '), state, code_challenge_method:'S256', code_challenge:pkceChallenge(verifier)}).toString();
    return {url:url.toString(), browserToken};
  }
  async callback(query: {state?: string; code?: string; error?: string}, browserToken?: string) {
    if (!query.state || !browserToken || !/^[\w-]{43}$/.test(query.state)) throw new SpotifyError('OAUTH_STATE_INVALID', 'Spotify login expired or could not be verified. Start again.', 400);
    const stateHash = digest(query.state);
    const attempt = await this.store.transaction(async tx => {
      const row = await tx.getOAuth(stateHash);
      if (!row || row.expiresAt <= this.http.now() || !equalSecret(row.browserHash, digest(browserToken))) throw new SpotifyError('OAUTH_STATE_INVALID', 'Spotify login expired or could not be verified. Start again.', 400);
      await tx.deleteOAuth(stateHash); // Single-use even when Spotify denies consent or exchange fails.
      return row;
    });
    if (query.error) throw new SpotifyError('OAUTH_ACCESS_DENIED', 'Spotify authorization was declined. You can try again.', 400);
    if (!query.code || query.code.length > 4096) throw new SpotifyError('OAUTH_CODE_REQUIRED', 'Spotify did not return an authorization code.', 400);
    const verifier = this.cipher.open(attempt.verifier, `oauth:${stateHash}`);
    // Codes are single use: ambiguous exchange failure requires starting login again.
    const tokens = this.parseTokens(await this.http.json('https://accounts.spotify.com/api/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'authorization_code', client_id:this.config.clientId, redirect_uri:this.config.redirectUri, code:query.code, code_verifier:verifier})}, {token:true, attempts:1}));
    if (!tokens.refresh_token) throw new SpotifyError('SPOTIFY_INVALID_RESPONSE', 'Spotify did not issue a refresh credential. Reconnect your account.', 502);
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? [];
    this.requireReadScope(scopes);
    const parsed = profileSchema.safeParse(await this.http.json('https://api.spotify.com/v1/me', {headers:{Authorization:`Bearer ${tokens.access_token}`}}));
    if (!parsed.success) throw new SpotifyError('SPOTIFY_INVALID_RESPONSE', 'Spotify returned an invalid profile.', 502);
    const p = parsed.data, userId = `spotify:${p.id}`;
    IdSchema.parse(userId);
    const account: Account = {user:{id:userId, spotifyId:p.id, displayName:p.display_name ?? p.id, avatarUrl:HttpUrlSchema.safeParse(p.images?.[0]?.url).success ? p.images![0]!.url : null},
      accessToken:this.cipher.seal(tokens.access_token, `${userId}:access`), refreshToken:this.cipher.seal(tokens.refresh_token, `${userId}:refresh`), expiresAt:this.http.now() + tokens.expires_in * 1000, scopes, revoked:false, credentialVersion:crypto.randomUUID(), refreshLease:null};
    this.assertOwner(account);
    const sessionToken = newSecret();
    await this.store.transaction(async tx => {
      // A successful new login replaces prior credentials and sessions, preventing fixation.
      await tx.putAccount(account); await tx.deleteSessions(userId);
      await tx.putSession({hash:sessionHash(sessionToken, this.config.sessionSecret), userId, expiresAt:this.http.now() + this.config.sessionTtlMs});
    });
    return {account, sessionToken};
  }
  async session(token?: string): Promise<Account | null> {
    if (!token || !/^[\w-]{43}$/.test(token)) return null;
    return this.store.transaction(async tx => {
      const hash = sessionHash(token, this.config.sessionSecret), session = await tx.getSession(hash);
      if (!session) return null;
      if (session.expiresAt <= this.http.now()) {await tx.deleteSession(hash); return null;}
      const account = await tx.getAccount(session.userId);
      if (!account || account.revoked) return null;
      this.assertOwner(account);
      return account;
    });
  }
  async logout(token?: string) {if (token) await this.store.transaction(tx => tx.deleteSession(sessionHash(token, this.config.sessionSecret)));}
  publicSession(account: Account | null): AccountSession {
    return {mode:account ? 'spotify' : 'anonymous', user:account?.user ?? null, capabilities:{spotifyRead:!!account && account.scopes.includes('user-library-read'), spotifyWrite:false, playback:false}};
  }
  async revoke(userId: string, version: string, refreshLeaseId?: string) {
    return this.store.transaction(async tx => {
      const account = await tx.getAccount(userId);
      if (!account || account.credentialVersion !== version || (refreshLeaseId !== undefined && account.refreshLease?.id !== refreshLeaseId)) return false;
      await tx.putAccount({...account, accessToken:'', refreshToken:'', revoked:true, refreshLease:null});
      await tx.deleteSessions(userId);
      return true;
    });
  }
  /** Fenced, durable refresh lease prevents concurrent rotation across API replicas. */
  async accessToken(userId: string, rejectedVersion?: string): Promise<AccessCredential> {
    const deadline = this.http.now() + 125_000;
    for (;;) {
      const leaseId = crypto.randomUUID();
      const claim = await this.store.transaction(async tx => {
        const account = await tx.getAccount(userId);
        if (!account) throw authenticationRequired();
        this.assertOwner(account); this.requireReadScope(account.scopes);
        if (account.expiresAt > this.http.now() + 60_000 && account.credentialVersion !== rejectedVersion) return {account, refresh:false, wait:false};
        if (account.refreshLease && account.refreshLease.until > this.http.now()) return {account, refresh:false, wait:true};
        account.refreshLease = {id:leaseId, until:this.http.now() + 120_000};
        await tx.putAccount(account);
        return {account, refresh:true, wait:false};
      });
      if (claim.wait) {
        if (this.http.now() >= deadline) throw new SpotifyError('REFRESH_BUSY', 'Spotify credentials are being refreshed. Retry shortly.', 503, true);
        await this.http.sleep(100); continue;
      }
      if (!claim.refresh) return {token:this.cipher.open(claim.account.accessToken, `${userId}:access`), version:claim.account.credentialVersion};
      try {
        const refreshToken = this.cipher.open(claim.account.refreshToken, `${userId}:refresh`);
        const tokens = this.parseTokens(await this.http.json('https://accounts.spotify.com/api/token', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'refresh_token', client_id:this.config.clientId, refresh_token:refreshToken})}, {token:true, attempts:2}));
        const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? claim.account.scopes;
        this.requireReadScope(scopes);
        const saved = await this.store.transaction(async tx => {
          const current = await tx.getAccount(userId);
          if (!current || current.revoked || current.refreshLease?.id !== leaseId || current.credentialVersion !== claim.account.credentialVersion) return null;
          const account: Account = {...current, scopes, accessToken:this.cipher.seal(tokens.access_token, `${userId}:access`), refreshToken:tokens.refresh_token ? this.cipher.seal(tokens.refresh_token, `${userId}:refresh`) : current.refreshToken, expiresAt:this.http.now() + tokens.expires_in * 1000, credentialVersion:crypto.randomUUID(), refreshLease:null};
          await tx.putAccount(account); return account;
        });
        if (!saved) continue; // Concurrent reauthorization won. Never overwrite its credentials.
        return {token:tokens.access_token, version:saved.credentialVersion};
      } catch (error) {
        if (error instanceof SpotifyError && ['SPOTIFY_REAUTH_REQUIRED', 'SPOTIFY_SCOPE_REQUIRED'].includes(error.code)) {
          const revoked = await this.revoke(userId, claim.account.credentialVersion, leaseId);
          if (!revoked) throw new SpotifyError('REFRESH_SUPERSEDED', 'A newer Spotify authorization is in progress. Retry shortly.', 503, true);
        }
        await this.store.transaction(async tx => {
          const account = await tx.getAccount(userId);
          if (account?.refreshLease?.id === leaseId) await tx.putAccount({...account, refreshLease:null});
        });
        throw error;
      }
    }
  }
  private requireReadScope(scopes: string[]) {if (!scopes.includes('user-library-read')) throw new SpotifyError('SPOTIFY_SCOPE_REQUIRED', 'Reconnect Spotify with permission to read your Liked Songs.', 403);}
  private parseTokens(value: unknown) {
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new SpotifyError('SPOTIFY_INVALID_RESPONSE', 'Spotify returned an invalid token response.', 502);
    return parsed.data;
  }
}
