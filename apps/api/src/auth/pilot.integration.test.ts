import {expect,test} from 'bun:test';
import {buildApp} from '../app';
import {loadSpotifyConfig} from './config';
import {createSpotifyModule} from './module';
import {TestStore} from './test-support/store';
import {SpotifyHttp} from '../spotify/http';
import {createPilotOAuthFetch} from '../spotify/pilot-transport';
import {installPilotGuards} from '../reviews/pilot';
import {createReviewMutationModule} from '../reviews/module';
import {ReviewService} from '../reviews/service';
import type {ReviewRepository} from '../reviews/store';
import type {ReviewResult} from '@sortfm/contracts';
const env={SPOTIFY_CLIENT_ID:'client',SPOTIFY_ALLOWED_USER_IDS:'owner',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'s'.repeat(40)};
test('guarded runtime completes fresh PKCE/session/refresh, blocks import and playback, and logs out',async()=>{
 const config=loadSpotifyConfig(env),store=new TestStore();let now=Date.now(),recoveries=0,playback=0;
 store.resumableUserIds=async()=>{recoveries++;return ['spotify:owner'];};
 const calls:{url:string;body?:URLSearchParams}[]=[];
 const http=new SpotifyHttp({now:()=>now,fetch:createPilotOAuthFetch(async(url,init)=>{
  const body=init?.body instanceof URLSearchParams?init.body:undefined;calls.push({url,body});
  if(url.endsWith('/api/token')){
   if(body?.get('grant_type')==='authorization_code')expect(body.get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
   return Response.json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:config.scopes.join(' ')});
  }
  return Response.json({id:'owner',display_name:'Synthetic owner',images:[]});
 })});
 const module=createSpotifyModule({config,store,http,backgroundImportEnabled:false,playbackCallback:async()=>{playback++;return 'review';}});
 const admission={getPublishedExposure:async()=>null,getDecision:async()=>null,getDecisionByIdempotencyKey:async()=>null,getUndoByIdempotencyKey:async()=>null};
 const app=await buildApp({config,beforeRoutes:app=>installPilotGuards(app,{config,auth:module.auth,admission}),registerRoutes:module.registerRoutes});
 try{
  expect(recoveries).toBe(0);expect(calls).toHaveLength(0);
  const start=await app.inject('/api/auth/spotify/start'),authorize=new URL(start.headers.location!);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const oauth=start.cookies[0]!,state=authorize.searchParams.get('state');
  const callback=await app.inject({url:`/api/auth/spotify/callback?state=${state}&code=synthetic`,cookies:{[oauth.name]:oauth.value}});
  expect(callback.statusCode).toBe(302);
  const session=callback.cookies.find(c=>c.name==='sortfm_session'&&c.value)!;
  expect(session.httpOnly).toBe(true);const cookies={[session.name]:session.value};
  const me=await app.inject({url:'/api/me',cookies});
  expect(me.statusCode).toBe(200);expect(me.json().user.spotifyId).toBe('owner');expect(me.body).not.toContain('private-access');expect(me.body).not.toContain('private-refresh');
  now+=3600_000;await module.auth.accessToken('spotify:owner');
  expect(calls.map(c=>c.body?.get('grant_type')??'profile')).toEqual(['authorization_code','profile','refresh_token']);
  for(const url of ['/api/library/sync','/api/player/connect','/api/player/token','/api/player/sdk/play','/api/ml/retrain'])expect((await app.inject({method:'POST',url,cookies,headers:{origin:config.webOrigin},payload:{}})).statusCode).toBe(403);
  expect((await app.inject('/api/auth/spotify/callback?state=playback-sdk.synthetic&code=synthetic')).statusCode).toBe(403);
  expect(playback).toBe(0);expect(recoveries).toBe(0);expect(store.data.jobs.size).toBe(0);expect(calls).toHaveLength(3);
  expect((await app.inject({method:'POST',url:'/api/auth/logout',cookies,headers:{origin:config.webOrigin}})).statusCode).toBe(200);
  expect((await app.inject({url:'/api/me',cookies})).statusCode).toBe(401);
 }finally{await app.close();}
});
test('inherited early service replay cannot kick a review worker or return an old Undo',async()=>{
 const config=loadSpotifyConfig(env),id=crypto.randomUUID(),exposureId=crypto.randomUUID(),key=crypto.randomUUID();
 const decision={decisionId:id,exposureId,idempotencyKey:key,action:'KEEP',trackId:'0000000000000000000001',mode:'spotify',status:'UNDONE'} as ReviewResult;
 let kicks=0,serviceReads=0;
 const repo={getDecisionByIdempotencyKey:async()=>{serviceReads++;return decision;},getDecision:async()=>{serviceReads++;return decision;},getUndoByIdempotencyKey:async()=>null} as unknown as ReviewRepository;
 const service=new ReviewService(repo,{auth:{requireScopes:async()=>{}},worker:{kick:()=>{kicks++;}}});
 const auth={session:async(token?:string)=>token==='valid'?{user:{id:'spotify:owner'}}:null};
 const admission={getPublishedExposure:async()=>null,getDecision:async()=>decision,getDecisionByIdempotencyKey:async()=>decision,getUndoByIdempotencyKey:async()=>null};
 const module=createReviewMutationModule({config,auth,service,worker:{start:()=>{},close:async()=>{}},enableWrites:()=>{}});
 const app=await buildApp({config,beforeRoutes:app=>installPilotGuards(app,{config,auth,admission}),registerRoutes:module.registerRoutes});
 try{
  const headers={cookie:'sortfm_session=valid',origin:config.webOrigin};
  expect((await app.inject({method:'POST',url:'/api/decisions',headers,payload:{trackId:decision.trackId,action:'KEEP',exposureId,idempotencyKey:key}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:`/api/decisions/${id}/undo`,headers,payload:{idempotencyKey:key}})).statusCode).toBe(403);
  expect(kicks).toBe(0);expect(serviceReads).toBe(0);
 }finally{await app.close();}
});

test('pilot write capability requires every actual grant and OAuth transport remains restricted',async()=>{
 const {WRITE_SCOPES}=await import('../spotify/scopes');
 for(const missing of [...WRITE_SCOPES,null]){
  const config=loadSpotifyConfig(env),store=new TestStore(),granted=[...new Set([...config.scopes,...WRITE_SCOPES])].filter(scope=>scope!==missing);
  let calls=0;
  const module=createSpotifyModule({config,store,backgroundImportEnabled:false,http:new SpotifyHttp({fetch:createPilotOAuthFetch(async url=>{
   calls++;return Response.json(url.endsWith('/api/token')?{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,token_type:'Bearer',scope:granted.join(' ')}:{id:'owner',display_name:'Synthetic owner',images:[]});
  })})});
  module.auth.enableReviewWrites();
  const start=await module.auth.start(),authorization=new URL(start.url);
  for(const scope of WRITE_SCOPES)expect(authorization.searchParams.get('scope')!.split(' ')).toContain(scope);
  const {account}=await module.auth.callback({state:authorization.searchParams.get('state')!,code:'synthetic'},start.browserToken);
  expect(module.auth.publicSession(account).capabilities.spotifyWrite).toBe(missing===null);
  if(missing)await expect(module.auth.requireScopes(account.user.id,[...WRITE_SCOPES])).rejects.toMatchObject({code:'SPOTIFY_SCOPE_REQUIRED'});
  else await module.auth.requireScopes(account.user.id,[...WRITE_SCOPES]);
  await expect(module.auth.http.json('https://api.spotify.com/v1/me/library',{method:'DELETE'})).rejects.toMatchObject({code:'PILOT_ACTION_NOT_ALLOWED'});
  expect(calls).toBe(2);expect(store.data.jobs.size).toBe(0);
 }
});
