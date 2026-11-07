import {expect, test} from 'bun:test';
import {loadSpotifyConfig} from './config';
import {AuthService} from './service';
import {SpotifyHttp} from '../spotify/http';
import {SpotifyClient} from '../spotify/client';
import {TestStore} from './test-support/store';
import {pkceChallenge} from './crypto';

export const testConfig = () => loadSpotifyConfig({SPOTIFY_CLIENT_ID:'test-client', SPOTIFY_ALLOWED_USER_IDS:'owner', TOKEN_ENCRYPTION_KEY:Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET:'s'.repeat(40)});
export const profile = {id:'owner', display_name:'Owner', images:[]};
export const token = {access_token:'access-secret', refresh_token:'refresh-secret', token_type:'Bearer', expires_in:3600, scope:'user-library-read user-read-private user-read-recently-played'};

function setup(options: {owner?:string; fetch?: (url:string, init?:RequestInit) => Promise<Response>} = {}) {
  let now = Date.parse('2026-11-07T12:00:00Z');
  const store = new TestStore();
  const requests: {url:string; init?:RequestInit}[] = [];
  const http = new SpotifyHttp({now:() => now, sleep:async ms => {now += ms;}, fetch:async (url, init) => {
    requests.push({url, init});
    return options.fetch ? options.fetch(url, init) : Response.json(url.includes('/api/token') ? token : {...profile, id:options.owner ?? 'owner'});
  }});
  const auth = new AuthService(testConfig(), store, http);
  return {auth, store, http, requests, advance:(ms:number) => {now += ms;}};
}
export async function login(auth: AuthService) {
  const start = await auth.start();
  return auth.callback({state:new URL(start.url).searchParams.get('state')!, code:'code'}, start.browserToken);
}

test('OAuth binds state to browser, verifies PKCE and persists only encrypted credentials and hashed sessions', async () => {
  const {auth, store, requests} = setup();
  const start = await auth.start(); const url = new URL(start.url), state = url.searchParams.get('state')!;
  await expect(auth.callback({state, code:'code'}, 'wrong-browser')).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
  expect(requests.length).toBe(0);
  const result = await auth.callback({state, code:'code'}, start.browserToken);
  expect(result.account.user.spotifyId).toBe('owner');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const body = new URLSearchParams(requests[0]!.init!.body as URLSearchParams);
  expect(pkceChallenge(body.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge')!);
  expect(body.get('redirect_uri')).toBe('http://127.0.0.1:3001/api/auth/spotify/callback');
  expect(body.has('client_secret')).toBe(false);
  const persisted = JSON.stringify([...store.data.accounts.values()]);
  expect(persisted).not.toContain('access-secret'); expect(persisted).not.toContain('refresh-secret');
  expect(JSON.stringify([...store.data.sessions.values()])).not.toContain(result.sessionToken);
  await expect(auth.callback({state, code:'code'}, start.browserToken)).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
  expect((await auth.session(result.sessionToken))?.user.id).toBe('spotify:owner');
});

test('wrong accounts, denied consent, expired state and insufficient scope create no session', async () => {
  const wrong = setup({owner:'intruder'});
  await expect(login(wrong.auth)).rejects.toMatchObject({statusCode:403});
  expect(wrong.store.data.accounts.size).toBe(0); expect(wrong.store.data.sessions.size).toBe(0);
  const expired = setup(); const start = await expired.auth.start(); expired.advance(601_000);
  await expect(expired.auth.callback({state:new URL(start.url).searchParams.get('state')!, code:'code'}, start.browserToken)).rejects.toMatchObject({code:'OAUTH_STATE_INVALID'});
  const denied = setup(); const begin = await denied.auth.start();
  await expect(denied.auth.callback({state:new URL(begin.url).searchParams.get('state')!, error:'access_denied'}, begin.browserToken)).rejects.toMatchObject({code:'OAUTH_ACCESS_DENIED'});
  expect(denied.requests.length).toBe(0);
  const scopes = setup({fetch:async url => Response.json(url.includes('/api/token') ? {...token, scope:'user-read-private'} : profile)});
  await expect(login(scopes.auth)).rejects.toMatchObject({code:'SPOTIFY_SCOPE_REQUIRED'});
});

test('refresh is serialized across service instances, rotates tokens, and survives restart', async () => {
  let refreshes = 0; const refreshTokens: string[] = [];
  const ctx = setup({fetch:async (url, init) => {
    if (!url.includes('/api/token')) return Response.json(profile);
    const body = new URLSearchParams(init!.body as URLSearchParams);
    if (body.get('grant_type') === 'refresh_token') {
      refreshes++; refreshTokens.push(body.get('refresh_token')!);
      return Response.json({...token, access_token:`rotated-${refreshes}`, refresh_token:refreshes === 1 ? 'rotated-refresh' : undefined});
    }
    return Response.json(token);
  }});
  const result = await login(ctx.auth); ctx.advance(3_600_000);
  const restarted = new AuthService(testConfig(), ctx.store, ctx.http);
  const tokens = await Promise.all([ctx.auth.accessToken(result.account.user.id), restarted.accessToken(result.account.user.id)]);
  expect(tokens.map(x => x.token)).toEqual(['rotated-1', 'rotated-1']); expect(refreshes).toBe(1);
  ctx.advance(3_600_000); await restarted.accessToken(result.account.user.id);
  ctx.advance(3_600_000); await restarted.accessToken(result.account.user.id);
  expect(refreshTokens).toEqual(['refresh-secret', 'rotated-refresh', 'rotated-refresh']);
  expect((await restarted.session(result.sessionToken))?.user.spotifyId).toBe('owner');
});

test('invalid_grant revokes credentials and all sessions', async () => {
  const ctx = setup({fetch:async (url, init) => {
    if (!url.includes('/api/token')) return Response.json(profile);
    return new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token' ? Response.json({error:'invalid_grant'}, {status:400}) : Response.json(token);
  }});
  const result = await login(ctx.auth); ctx.advance(3_600_000);
  await expect(ctx.auth.accessToken(result.account.user.id)).rejects.toMatchObject({code:'SPOTIFY_REAUTH_REQUIRED'});
  expect(await ctx.auth.session(result.sessionToken)).toBeNull();
  expect(ctx.store.data.accounts.get(result.account.user.id)?.revoked).toBe(true);
});

test('GET client refreshes once on 401, then returns terminal authorization error', async () => {
  let reads = 0, refreshes = 0;
  const ctx = setup({fetch:async (url, init) => {
    if (url.endsWith('/me')) return Response.json(profile);
    if (url.includes('/api/token')) {
      if (new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token') {refreshes++; return Response.json({...token, access_token:'new'});}
      return Response.json(token);
    }
    reads++; return new Response('', {status:401});
  }});
  const {account} = await login(ctx.auth); const client = new SpotifyClient(ctx.auth, ctx.http);
  await expect(client.get(account.user.id, '/me/tracks?limit=50&offset=0')).rejects.toMatchObject({code:'SPOTIFY_REAUTH_REQUIRED'});
  expect(reads).toBe(2); expect(refreshes).toBe(1);
  await expect(client.get(account.user.id, 'https://attacker.test/')).rejects.toThrow();
});

test('logout and allowlist removal invalidate access independently of access token expiry', async () => {
  const ctx = setup(); const result = await login(ctx.auth);
  const config = testConfig(); config.allowedUserIds.clear();
  await expect(new AuthService(config, ctx.store, ctx.http).session(result.sessionToken)).rejects.toMatchObject({statusCode:403});
  await ctx.auth.logout(result.sessionToken);
  expect(await ctx.auth.session(result.sessionToken)).toBeNull();
});

test('an expired refresh worker cannot revoke a newer worker lease or its sessions', async () => {
  let firstStarted!: () => void, secondStarted!: () => void, failFirst!: () => void, finishSecond!: () => void;
  const firstBegan = new Promise<void>(r => {firstStarted = r;}), secondBegan = new Promise<void>(r => {secondStarted = r;});
  const firstGate = new Promise<void>(r => {failFirst = r;}), secondGate = new Promise<void>(r => {finishSecond = r;});
  let refreshes = 0;
  const ctx = setup({fetch:async (url, init) => {
    if (!url.includes('/api/token')) return Response.json(profile);
    if (new URLSearchParams(init!.body as URLSearchParams).get('grant_type') !== 'refresh_token') return Response.json(token);
    refreshes++;
    if (refreshes === 1) {firstStarted(); await firstGate; return Response.json({error:'invalid_grant'}, {status:400});}
    secondStarted(); await secondGate; return Response.json({...token, access_token:'new-owner-token', refresh_token:'new-refresh'});
  }});
  const result = await login(ctx.auth); ctx.advance(3_600_000);
  const first = ctx.auth.accessToken(result.account.user.id).catch(error => error);
  await firstBegan; ctx.advance(120_001);
  const second = new AuthService(testConfig(), ctx.store, ctx.http).accessToken(result.account.user.id);
  await secondBegan; failFirst(); await first;
  const interim = ctx.store.data.accounts.get(result.account.user.id)!;
  expect(interim.revoked).toBe(false); expect(interim.refreshLease).not.toBeNull();
  expect(await ctx.auth.session(result.sessionToken)).not.toBeNull();
  finishSecond(); expect((await second).token).toBe('new-owner-token');
});

test('refresh retries are bounded to fit inside the durable lease', async () => {
  let refreshes = 0;
  const ctx = setup({fetch:async (url, init) => {
    if (!url.includes('/api/token')) return Response.json(profile);
    if (new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token') {refreshes++; return new Response('', {status:503});}
    return Response.json(token);
  }});
  const result = await login(ctx.auth); ctx.advance(3_600_000);
  await expect(ctx.auth.accessToken(result.account.user.id)).rejects.toMatchObject({code:'SPOTIFY_UNAVAILABLE'});
  expect(refreshes).toBe(2);
  expect(ctx.store.data.accounts.get(result.account.user.id)?.refreshLease).toBeNull();
});

test('expired sessions stop authenticating and a successful read retries with the refreshed bearer', async () => {
  let reads = 0;
  const ctx = setup({fetch:async (url, init) => {
    if (url.endsWith('/me')) return Response.json(profile);
    if (url.includes('/api/token')) {
      const refreshing = new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token';
      return Response.json(refreshing ? {...token, access_token:'new-bearer'} : token);
    }
    reads++;
    if (reads === 1) return new Response('', {status:401});
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-bearer');
    return Response.json({items:[], total:0});
  }});
  const result = await login(ctx.auth);
  expect(await new SpotifyClient(ctx.auth, ctx.http).get(result.account.user.id, '/me/tracks?limit=50&offset=0')).toEqual({items:[], total:0});
  expect(reads).toBe(2); expect(await ctx.auth.session(result.sessionToken)).not.toBeNull();
  ctx.advance(31 * 24 * 60 * 60 * 1000);
  expect(await ctx.auth.session(result.sessionToken)).toBeNull(); expect(ctx.store.data.sessions.size).toBe(0);
});

test('concurrent reauthorization wins over an old successful refresh without overwriting credentials', async () => {
  let begin!: () => void, finish!: () => void;
  const begun = new Promise<void>(r => {begin = r;}), gate = new Promise<void>(r => {finish = r;});
  const ctx = setup({fetch:async (url, init) => {
    if (!url.includes('/api/token')) return Response.json(profile);
    if (new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token') {begin(); await gate; return Response.json({...token, access_token:'obsolete-token'});}
    return Response.json(token);
  }});
  const first = await login(ctx.auth); ctx.advance(3_600_000);
  const refreshing = ctx.auth.accessToken(first.account.user.id); await begun;
  const second = await login(ctx.auth); finish();
  expect((await refreshing).token).toBe('access-secret');
  expect(await ctx.auth.session(first.sessionToken)).toBeNull(); expect(await ctx.auth.session(second.sessionToken)).not.toBeNull();
});
