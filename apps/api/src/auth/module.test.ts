import {afterEach, expect, test} from 'bun:test';
import {buildApp} from '../app';
import {loadSpotifyConfig} from './config';
import {createSpotifyModule} from './module';
import {TestStore} from './test-support/store';
import {SpotifyHttp} from '../spotify/http';
import {AccountSessionSchema, LibraryImportStatusSchema, LibrarySummarySchema} from '@sortfm/contracts';
import type {FastifyInstance} from 'fastify';

const apps: FastifyInstance[] = [];
afterEach(async () => {await Promise.all(apps.splice(0).map(app => app.close()));});
const env = {SPOTIFY_CLIENT_ID:'client', SPOTIFY_ALLOWED_USER_IDS:'owner', TOKEN_ENCRYPTION_KEY:Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET:'s'.repeat(40)};
async function setup(production = false, wrongUser = false) {
  const config = loadSpotifyConfig({...env, ...(production ? {NODE_ENV:'production'} : {})}), store = new TestStore();
  const paths: string[] = [];
  const http = new SpotifyHttp({fetch:async (url, init) => {
    paths.push(url);
    if (url.includes('/api/token')) return Response.json({access_token:'secret-access', refresh_token:'secret-refresh', expires_in:3600, token_type:'Bearer', scope:'user-library-read user-read-private user-read-recently-played'});
    expect(init?.method ?? 'GET').toBe('GET');
    if (url.endsWith('/me')) return Response.json({id:wrongUser ? 'intruder' : 'owner', display_name:'Listener', images:[]});
    if (url.includes('recently-played')) return Response.json({items:[]});
    return Response.json({offset:0, limit:50, total:1, next:null, items:[{added_at:'2020-01-01T00:00:00Z', track:{id:'0000000000000000000001', name:'Example', duration_ms:120000, artists:[{id:'artist', name:'Artist'}]}}]});
  }});
  const module = createSpotifyModule({config, store, http});
  const app = await buildApp({config, registerRoutes:module.registerRoutes}); apps.push(app);
  return {app, module, store, paths, config};
}
async function connect(app: FastifyInstance) {
  const start = await app.inject({method:'GET', url:'/api/auth/spotify/start'});
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location!).searchParams.get('state')!;
  const cookie = start.cookies[0]!;
  const callback = await app.inject({method:'GET', url:`/api/auth/spotify/callback?state=${state}&code=code`, cookies:{[cookie.name]:cookie.value}});
  return {start, callback};
}

test('A1 registrar replaces foundation /me and serves secure public DTOs after login', async () => {
  const {app, paths} = await setup(true);
  const {start, callback} = await connect(app);
  expect(callback.statusCode).toBe(302); expect(callback.headers.location).toBe('https://sort.fm');
  expect(start.headers['cache-control']).toBe('no-store');
  expect(start.headers['referrer-policy']).toBe('no-referrer');
  const session = callback.cookies.find(c => c.name === '__Host-sortfm_session')!;
  expect(session).toMatchObject({httpOnly:true, secure:true, path:'/', sameSite:'Lax'});
  expect(session.domain).toBeUndefined();
  const me = await app.inject({url:'/api/me', cookies:{[session.name]:session.value}});
  expect(me.statusCode).toBe(200); expect(AccountSessionSchema.parse(me.json())).toMatchObject({mode:'spotify', user:{spotifyId:'owner'}, capabilities:{spotifyRead:true, spotifyWrite:false}});
  expect(me.body).not.toContain('secret'); expect(me.body).not.toContain('Token');
  expect(paths.filter(x => x.includes('/me/tracks')).length).toBe(0);
});

test('anonymous reads are safe; owner endpoints reject missing/forged sessions and foreign origins', async () => {
  const {app, store} = await setup();
  expect((await app.inject('/api/me')).json().mode).toBe('anonymous');
  for (const url of ['/api/library/summary', '/api/library/sync/status']) {
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url, headers:{cookie:'sortfm_session=forged'}})).statusCode).toBe(401);
  }
  expect((await app.inject({method:'POST', url:'/api/library/sync', headers:{origin:'https://evil.test'}})).statusCode).toBe(403);
  expect(store.data.jobs.size).toBe(0);
});

test('sync is explicit, asynchronous, coalesced and rejects CSRF/forged identity without writing Spotify', async () => {
  const {app, module, store, config, paths} = await setup(); const {callback} = await connect(app);
  const session = callback.cookies.find(c => c.name === 'sortfm_session')!, cookies = {[session.name]:session.value};
  const before = await app.inject({url:'/api/library/sync/status', cookies});
  expect(before.json().status).toBe('idle'); expect(store.data.jobs.size).toBe(0);
  expect((await app.inject({method:'POST', url:'/api/library/sync', cookies})).statusCode).toBe(403);
  expect((await app.inject({method:'POST', url:'/api/library/sync', cookies, headers:{origin:config.webOrigin}, payload:{userId:'attacker'}})).statusCode).toBe(400);
  const sync = await app.inject({method:'POST', url:'/api/library/sync', cookies, headers:{origin:config.webOrigin}});
  expect(sync.statusCode).toBe(202); expect(LibraryImportStatusSchema.parse(sync.json()).jobId).not.toBeNull();
  // Drain the public worker operation; the background kick shares the durable lease.
  for (let i = 0; i < 100 && (await module.importer.status('spotify:owner')).status !== 'complete'; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await app.inject({url:'/api/library/sync/status', cookies})).json()).toMatchObject({status:'complete', processed:1});
  const summary = await app.inject({url:'/api/library/summary', cookies});
  expect(LibrarySummarySchema.parse(summary.json())).toMatchObject({total:1, remaining:1, reviewed:0});
  expect(paths.every(x => !x.includes('/me/library') && !x.includes('/playlists'))).toBe(true);
  expect((await app.inject({method:'POST', url:'/api/auth/logout', cookies, headers:{origin:config.webOrigin}})).json()).toEqual({ok:true});
  expect((await app.inject({url:'/api/library/summary', cookies})).statusCode).toBe(401);
});

test('wrong account callback uses safe error envelope and sets no session cookie', async () => {
  const {app} = await setup(false, true); const {callback} = await connect(app);
  expect(callback.statusCode).toBe(403); expect(callback.json().code).toBe('ACCOUNT_NOT_ALLOWED');
  expect(callback.cookies.some(c => c.name === 'sortfm_session' && c.value)).toBe(false);
  expect(callback.body).not.toContain('secret');
});

test('callback validation, duplicate cookies and disallowed query fields cannot select an account', async () => {
  const {app} = await setup();
  expect((await app.inject('/api/auth/spotify/callback?code=missing-state')).statusCode).toBe(400);
  const {callback} = await connect(app), session = callback.cookies.find(c => c.name === 'sortfm_session')!;
  expect((await app.inject({url:'/api/me', headers:{cookie:`${session.name}=${session.value}; ${session.name}=evil`}})).json().mode).toBe('anonymous');
  expect((await app.inject('/api/auth/spotify/start?redirect_uri=https://evil.test')).statusCode).toBe(400);
});

test('real HTTP socket serves login, credentialed session reads, sync and summary', async () => {
  const {app, config} = await setup();
  const address = await app.listen({port:0, host:'127.0.0.1'});
  const start = await fetch(`${address}/api/auth/spotify/start`, {redirect:'manual'});
  expect(start.status).toBe(302);
  const cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const state = new URL(start.headers.get('location')!).searchParams.get('state');
  const callback = await fetch(`${address}/api/auth/spotify/callback?state=${state}&code=code`, {headers:{Cookie:cookie}, redirect:'manual'});
  expect(callback.status).toBe(302);
  const session = callback.headers.getSetCookie().find(x => x.startsWith('sortfm_session='))!.split(';')[0]!;
  const me = await fetch(`${address}/api/me`, {headers:{Cookie:session, Origin:config.webOrigin}});
  expect(me.headers.get('access-control-allow-credentials')).toBe('true'); expect((await me.json() as {mode:string}).mode).toBe('spotify');
  const sync = await fetch(`${address}/api/library/sync`, {method:'POST', headers:{Cookie:session, Origin:config.webOrigin}});
  expect(sync.status).toBe(202);
  let progress: {status:string} = {status:'pending'};
  for (let i = 0; i < 100 && progress.status !== 'complete'; i++) {
    progress = await (await fetch(`${address}/api/library/sync/status`, {headers:{Cookie:session}})).json() as {status:string};
    if (progress.status !== 'complete') await new Promise(r => setTimeout(r, 1));
  }
  expect(progress.status).toBe('complete');
  expect(await (await fetch(`${address}/api/library/summary`, {headers:{Cookie:session}})).json()).toMatchObject({total:1, remaining:1});
});
