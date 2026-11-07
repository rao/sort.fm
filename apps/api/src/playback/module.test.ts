import {afterEach,expect,test} from 'bun:test';
import Fastify,{type FastifyInstance} from 'fastify';
import {createPlaybackModule} from './module';
import {PlaybackControls} from './controls';
import {fixture,config} from './fixtures';
import {sessionToken} from './test-support';
import {createSpotifyModule} from '../auth/module';
import {TestStore} from '../auth/test-support/store';
import {SpotifyHttp} from '../spotify/http';
import {row} from '../calibration/test-fixtures';
const apps:FastifyInstance[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(production=false,hook=true){
 const f=fixture(),app=Fastify({logger:false});apps.push(app);
 const cfg={...config,secureCookies:production},controls=new PlaybackControls(f.service,{track:async()=>row(1).track});
 const playback=createPlaybackModule({config:cfg,service:f.service,controls});
 const primaryStore=new TestStore();let primaryCalls=0;
 const primary=createSpotifyModule({config:cfg,store:primaryStore,http:new SpotifyHttp({fetch:async()=>{primaryCalls++;throw Error('unexpected primary request');}}),...(hook?{playbackCallback:playback.callback}:{})});
 await primary.registerRoutes(app);await playback.registerRoutes(app);
 const cookies={[production?'__Host-sortfm_session':'sortfm_session']:sessionToken};
 const post=(url:string,payload:Record<string,unknown>={},headers:Record<string,string>={origin:cfg.webOrigin})=>app.inject({method:'POST',url,payload,headers,cookies});
 return {...f,app,post,primaryStore,cfg,primaryCalls:()=>primaryCalls,cookies};
}
test('routes require owner, exact origin, unambiguous cookie and strict contract; no credential-bearing failures',async()=>{
 const f=await setup();
 for(const url of ['/api/player/connect','/api/player/token','/api/player/sdk/play','/api/player/transfer']){
  const result=await f.post(url,{},{});expect(result.statusCode).toBe(403);expect(result.headers['cache-control']).toBe('no-store');expect(result.headers['referrer-policy']).toBe('no-referrer');
 }
 expect((await f.post('/api/player/token',{}, {origin:'https://evil.test'})).statusCode).toBe(403);
 expect((await f.post('/api/player/token',{ownerId:'attacker'})).statusCode).toBe(400);
 expect((await f.post('/api/player/connect',{returnTo:'https://evil.test'})).statusCode).toBe(400);
 expect((await f.app.inject('/api/player/connection')).statusCode).toBe(401);
 expect((await f.app.inject({url:'/api/player/connection',headers:{cookie:`sortfm_session=${sessionToken}; sortfm_session=${sessionToken}`}})).statusCode).toBe(401);
 expect((await f.post('/api/player/token?ownerId=attacker')).statusCode).toBe(400);
 expect((await f.post('/api/player/token')).json().code).toBe('PLAYBACK_RECONNECT_REQUIRED');
 await f.connect();const token=await f.post('/api/player/token');expect(token.statusCode).toBe(200);expect(Object.keys(token.json()).sort()).toEqual(['accessToken','expiresAt','ownerId','scopes','tokenType']);expect(token.body).not.toContain('refresh');
 f.intercept(async()=>{throw Error('Bearer raw-secret');});const bad=await f.post('/api/player/token');expect(bad.statusCode).toBe(503);expect(bad.body).not.toContain('raw-secret');
});
test('playback callback uses purpose cookie without clearing or replacing primary credentials or OAuth state',async()=>{
 const f=await setup(true),primaryStart=await f.app.inject('/api/auth/spotify/start'),before=structuredClone(f.primaryStore.data);
 const start=await f.post('/api/player/connect',{returnTo:'calibration'});expect(start.statusCode).toBe(200);expect(Object.keys(start.json())).toEqual(['authorizationUrl']);
 const cookie=start.cookies[0]!;expect(cookie).toMatchObject({name:'__Host-sortfm_playback_sdk',httpOnly:true,secure:true,path:'/',sameSite:'Lax'});expect(cookie.domain).toBeUndefined();
 const state=new URL(start.json().authorizationUrl).searchParams.get('state')!;
 const callback=()=>f.app.inject({url:`/api/auth/spotify/callback?state=${state}&code=code&ubi=ignored`,cookies:{...f.cookies,[cookie.name]:cookie.value,[primaryStart.cookies[0]!.name]:primaryStart.cookies[0]!.value}});
 const response=await callback();expect(response.statusCode).toBe(302);expect(response.headers.location).toBe(`${f.cfg.webOrigin}/#/calibrate`);expect(response.cookies.map(c=>c.name)).toEqual([cookie.name]);expect(response.cookies[0]!.maxAge).toBe(0);
 expect(f.primaryStore.data).toEqual(before);expect(f.primaryCalls()).toBe(0);
 const replay=await callback();expect(replay.statusCode).toBe(400);expect(replay.json().code).toBe('OAUTH_STATE_INVALID');expect(f.primaryStore.data).toEqual(before);
});
test('any playback prefix fails closed, absent dispatcher and malformed/replayed states never reach primary OAuth',async()=>{
 for(const hook of [false,true]){
  const f=await setup(false,hook),pending=await f.app.inject('/api/auth/spotify/start'),before=structuredClone(f.primaryStore.data);
  for(const state of ['playback-sdk.bad','playback-other.bad',`playback-sdk.${'a'.repeat(43)}`,`playback-control.${'a'.repeat(43)}`]){
   const result=await f.app.inject({url:`/api/auth/spotify/callback?state=${state}&code=code`,cookies:{...f.cookies,sortfm_oauth:pending.cookies[0]!.value}});
   expect(result.statusCode).toBeGreaterThanOrEqual(400);expect(result.cookies.some(c=>['sortfm_oauth','sortfm_session'].includes(c.name))).toBe(false);
  }
  expect(f.primaryCalls()).toBe(0);expect(f.primaryStore.data).toEqual(before);
 }
});
test('denial clears only purpose cookie and consumes attempt, unknown provider fields cannot redirect',async()=>{
 const f=await setup();const start=await f.post('/api/player/connect',{returnTo:'review'}),cookie=start.cookies[0]!,state=new URL(start.json().authorizationUrl).searchParams.get('state');
 const response=await f.app.inject({url:`/api/auth/spotify/callback?state=${state}&error=access_denied&redirect_uri=https://evil.test`,cookies:{...f.cookies,[cookie.name]:cookie.value}});
 expect(response.statusCode).toBe(400);expect(response.json().code).toBe('OAUTH_ACCESS_DENIED');expect(response.cookies.map(c=>c.name)).toEqual([cookie.name]);expect(f.calls.length).toBe(0);
});

test('consume persistence primary-session loss maps to auth401 without exchanging code or exposing adapter details',async()=>{
 const f=await setup();
 const playbackOnly=await f.post('/api/player/token');expect(playbackOnly.statusCode).toBe(401);expect(playbackOnly.json().code).toBe('PLAYBACK_RECONNECT_REQUIRED');
 const start=await f.post('/api/player/connect',{returnTo:'review'}),cookie=start.cookies[0]!,state=new URL(start.json().authorizationUrl).searchParams.get('state');
 // Simulate session invalidation between AuthService.session and the atomic consume.
 f.store.consumeOAuth=async()=>{f.store.live=false;throw Object.assign(new Error('private-adapter-details'),{code:'AUTHENTICATION_REQUIRED'});};
 const response=await f.app.inject({url:`/api/auth/spotify/callback?state=${state}&code=private-code`,cookies:{...f.cookies,[cookie.name]:cookie.value}});
 expect(response.statusCode).toBe(401);expect(response.json()).toEqual({code:'AUTHENTICATION_REQUIRED',message:'Connect an authorized Spotify account.',retryable:false});
 expect(response.body).not.toContain('private-');expect(f.calls).toHaveLength(0);expect(f.primaryCalls()).toBe(0);
 expect(response.cookies.map(c=>c.name)).toEqual([cookie.name]);expect(f.store.grants.size).toBe(0);
});
test('consume invalid or unknown persistence errors remain safe OAuth state failures',async()=>{
 for(const code of ['OAUTH_STATE_INVALID','UNKNOWN_ERROR','PLAYBACK_RECONNECT_REQUIRED']){
  const f=await setup(),start=await f.post('/api/player/connect',{returnTo:'review'}),cookie=start.cookies[0]!,state=new URL(start.json().authorizationUrl).searchParams.get('state');
  f.store.consumeOAuth=async()=>{throw Object.assign(new Error('private-adapter-details'),{code});};
  const response=await f.app.inject({url:`/api/auth/spotify/callback?state=${state}&code=private-code`,cookies:{...f.cookies,[cookie.name]:cookie.value}});
  expect(response.statusCode).toBe(400);expect(response.json().code).toBe('OAUTH_STATE_INVALID');expect(response.body).not.toContain('private-');expect(f.calls).toHaveLength(0);expect(f.primaryCalls()).toBe(0);
 }
});
