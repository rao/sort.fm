import {expect,test} from 'bun:test';
import {Database,migrate,Repository} from '@sortfm/db';
import {AccountSessionSchema,PlaybackConnectionStatusSchema,PlaybackSdkTokenSchema} from '@sortfm/contracts';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';
import {PlaybackTransport} from '../src/playback';
import {row} from '../src/calibration/test-fixtures';

const databaseUrl=process.env.TEST_DATABASE_URL;
const webOrigin='https://playback-web.example',apiOrigin='https://playback-api.example';
const owner='controlled.playback',userId=`spotify:${owner}`;
const config=(schema:string)=>({NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema,
 PUBLIC_WEB_ORIGIN:webOrigin,PUBLIC_API_ORIGIN:apiOrigin,SPOTIFY_CLIENT_ID:'controlled-playback-client',
 SPOTIFY_ALLOWED_USER_IDS:`${owner},controlled.other`,TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,23).toString('base64'),
 SESSION_SECRET:'controlled-playback-session-test-only-'.repeat(3)});
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
const primaryProvider=async(url:string)=>{
 if(url.endsWith('/api/token'))return Response.json({access_token:'controlled-primary-access',refresh_token:'controlled-primary-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private'});
 if(url.endsWith('/me'))return Response.json({id:owner,display_name:'Controlled Playback Owner',images:[]});
 throw Error('Unexpected primary provider request');
};
async function login(runtime:Runtime){
 const start=await runtime.app.inject('/api/auth/spotify/start');expect(start.statusCode).toBe(302);
 const state=new URL(String(start.headers.location)).searchParams.get('state')!;
 const response=await runtime.app.inject({url:`/api/auth/spotify/callback?${new URLSearchParams({state,code:'primary-code'})}`,cookies:Object.fromEntries(start.cookies.map(c=>[c.name,c.value]))});
 expect(response.statusCode).toBe(302);
 const session=response.cookies.find(c=>c.name==='__Host-sortfm_session')!;
 expect(session).toMatchObject({httpOnly:true,secure:true,path:'/',sameSite:'Lax'});
 const cookies={[session.name]:session.value};
 expect(AccountSessionSchema.parse((await runtime.app.inject({url:'/api/me',cookies})).json()).user?.id).toBe(userId);
 return cookies;
}

test.skipIf(!databaseUrl)('unapplied playback migration disables only playback and preserves established authenticated routes',async()=>{
 const db=new Database(databaseUrl!,`test_playback_gate_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined;
 try{
  await migrate(db);
  await db.transaction(async tx=>{await tx`DROP TABLE IF EXISTS playback_oauth_attempts`;await tx`DROP TABLE IF EXISTS playback_grants`;});
  runtime=await buildRuntime({env:config(db.schema),spotifyHttp:new SpotifyHttp({fetch:primaryProvider})});
  expect(runtime.startupIssues).toEqual(['PLAYBACK_DATABASE_UNAVAILABLE']);
  const cookies=await login(runtime);
  expect((await runtime.app.inject('/api/health')).json().capabilities).toMatchObject({database:true,spotify:true});
  for(const url of ['/api/library/summary','/api/calibration/history','/api/decisions/history','/api/demo/bootstrap'])
   expect((await runtime.app.inject({url,cookies})).statusCode).toBe(200);
  expect((await runtime.app.inject({url:'/api/player/connection',cookies})).statusCode).toBe(501);
  const callback=await runtime.app.inject({url:`/api/auth/spotify/callback?state=playback-sdk.${'a'.repeat(43)}&code=unusable`,cookies});
  expect(callback.statusCode).toBe(503);expect(callback.json().code).toBe('PLAYBACK_UNAVAILABLE');
  expect(AccountSessionSchema.parse((await runtime.app.inject({url:'/api/me',cookies})).json()).mode).toBe('spotify');
 }finally{await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60_000);

function barrier(){
 let release!:()=>void;
 const promise=new Promise<void>(resolve=>{release=resolve;});
 return {promise,release};
}
async function startSdk(runtime:Runtime,cookies:Record<string,string>){
 const start=await runtime.app.inject({method:'POST',url:'/api/player/connect',cookies,headers:{origin:webOrigin},payload:{returnTo:'calibration'}});
 expect(start.statusCode).toBe(200);
 const state=new URL(start.json().authorizationUrl).searchParams.get('state')!,cookie=start.cookies[0]!;
 return ()=>runtime.app.inject({url:`/api/auth/spotify/callback?${new URLSearchParams({state,code:'sdk-code'})}`,cookies:{...cookies,[cookie.name]:cookie.value}}).then(result=>result);
}
const sdkTokenBody=(accessToken:string)=>({access_token:accessToken,refresh_token:'controlled-sdk-refresh',token_type:'Bearer',expires_in:30,scope:'streaming user-read-email user-read-private'});

test.skipIf(!databaseUrl)('concurrent expired SDK requests share one database refresh and reuse the actual short-lived replacement',async()=>{
 const db=new Database(databaseUrl!,`test_playback_refresh_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined,clock=Date.now(),refreshes=0;
 const entered=barrier(),resume=barrier();
 const pending:Promise<unknown>[]=[];
 try{
  await migrate(db);
  runtime=await buildRuntime({env:config(db.schema),spotifyHttp:new SpotifyHttp({fetch:primaryProvider}),
   playbackTransport:new PlaybackTransport({now:()=>clock,fetch:async(url,init)=>{
    if(url.endsWith('/api/token')){
     if((init!.body as URLSearchParams).get('grant_type')==='refresh_token'){
      refreshes++;expect((init!.body as URLSearchParams).get('refresh_token')).toBe('controlled-sdk-refresh');
      entered.release();await resume.promise;
      // Spotify may omit unchanged scopes on refresh; the stored exact set remains binding.
      const {scope:_,...body}=sdkTokenBody('controlled-short-replacement');return Response.json(body);
     }
     return Response.json(sdkTokenBody('controlled-short-original'));
    }
    if(url.endsWith('/me'))return Response.json({id:owner,product:'premium'});
    throw Error('Unexpected controlled refresh request');
   }}),
  });
  const cookies=await login(runtime),callback=await startSdk(runtime,cookies);
  expect((await callback()).statusCode).toBe(302);
  const [original]=await db.transaction(tx=>tx`SELECT payload FROM playback_grants WHERE user_id=${userId} AND purpose='sdk'`);
  clock+=31_000;
  const tokenRequest=()=>runtime!.app.inject({method:'POST',url:'/api/player/token',cookies,headers:{origin:webOrigin},payload:{}}).then(result=>result);
  const requests=Array.from({length:5},()=>tokenRequest());pending.push(...requests);
  await entered.promise;
  const [leased]=await db.transaction(tx=>tx`SELECT payload FROM playback_grants WHERE user_id=${userId} AND purpose='sdk'`);
  expect(leased.payload.credentialVersion).toBe(original.payload.credentialVersion);expect(leased.payload.refreshLease).not.toBeNull();
  resume.release();
  const responses=await Promise.all(requests);
  for(const response of responses){
   expect(response.statusCode).toBe(200);
   expect(PlaybackSdkTokenSchema.parse(response.json())).toMatchObject({ownerId:userId,accessToken:'controlled-short-replacement',expiresAt:new Date(clock+30_000).toISOString()});
  }
  expect(refreshes).toBe(1);
  const later=await tokenRequest();expect(later.statusCode).toBe(200);expect(later.json()).toEqual(responses[0]!.json());expect(refreshes).toBe(1);
  const [stored]=await db.transaction(tx=>tx`SELECT payload FROM playback_grants WHERE user_id=${userId} AND purpose='sdk'`);
  expect(stored.payload.credentialVersion).not.toBe(original.payload.credentialVersion);
  expect(stored.payload).toMatchObject({expiresAt:clock+30_000,revoked:false,refreshLease:null,scopes:['streaming','user-read-email','user-read-private']});
 }finally{resume.release();await Promise.allSettled(pending);await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60_000);

for(const phase of ['callback','refresh'] as const)test.skipIf(!databaseUrl)(`logout during blocked playback ${phase} prevents publication and browser token issuance`,async()=>{
 const db=new Database(databaseUrl!,`test_playback_flight_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined,clock=Date.now(),exchanges=0,pending:Promise<unknown>|undefined;
 const entered=barrier(),resume=barrier();
 try{
  await migrate(db);
  runtime=await buildRuntime({env:config(db.schema),spotifyHttp:new SpotifyHttp({fetch:primaryProvider}),
   playbackTransport:new PlaybackTransport({now:()=>clock,fetch:async(url,init)=>{
    if(url.endsWith('/api/token')){
     exchanges++;
     const isRefresh=(init!.body as URLSearchParams).get('grant_type')==='refresh_token';
     if(phase==='callback'||isRefresh){entered.release();await resume.promise;}
     return Response.json(sdkTokenBody(isRefresh?'controlled-unpublished-refresh':'controlled-unpublished-consent'));
    }
    if(url.endsWith('/me'))return Response.json({id:owner,product:'premium'});
    throw Error('Unexpected controlled in-flight request');
   }}),
  });
  const app=runtime.app,cookies=await login(runtime),callback=await startSdk(runtime,cookies);
  let oldVersion:string|undefined;
  if(phase==='refresh'){
   expect((await callback()).statusCode).toBe(302);
   const [old]=await db.transaction(tx=>tx`SELECT payload FROM playback_grants WHERE user_id=${userId} AND purpose='sdk'`);
   oldVersion=old.payload.credentialVersion;clock+=31_000;
  }
  const primaryBefore=await db.transaction(tx=>tx`SELECT encrypted_payload FROM oauth_credentials WHERE user_id=${userId}`);
  const request=phase==='callback'?callback():app.inject({method:'POST',url:'/api/player/token',cookies,headers:{origin:webOrigin},payload:{}}).then(result=>result);
  pending=request;
  await entered.promise;
  expect((await app.inject({method:'POST',url:'/api/auth/logout',cookies,headers:{origin:webOrigin},payload:{}})).statusCode).toBe(200);
  resume.release();
  const rejected=await request;
  expect(rejected.statusCode).toBe(401);expect(rejected.json().code).toBe('AUTHENTICATION_REQUIRED');
  expect(rejected.body).not.toContain('controlled-unpublished');expect(rejected.json()).not.toHaveProperty('accessToken');
  const stored=await db.transaction(tx=>tx`SELECT payload FROM playback_grants WHERE user_id=${userId} AND purpose='sdk'`);
  if(phase==='callback'){
   expect(stored).toHaveLength(0);
   const [attempt]=await db.transaction(tx=>tx`SELECT consumed_at,completed_at FROM playback_oauth_attempts WHERE user_id=${userId}`);
   expect(attempt.consumed_at).not.toBeNull();expect(attempt.completed_at).toBeNull();
  }else{
   expect(stored).toHaveLength(1);
   expect(stored[0]!.payload).toMatchObject({credentialVersion:oldVersion,revoked:true,encryptedAccessToken:'',encryptedRefreshToken:'',refreshLease:null});
  }
  expect(await db.transaction(tx=>tx`SELECT encrypted_payload FROM oauth_credentials WHERE user_id=${userId}`)).toEqual(primaryBefore);
  expect((await app.inject({method:'POST',url:'/api/player/token',cookies,headers:{origin:webOrigin},payload:{}})).statusCode).toBe(401);
  expect(exchanges).toBe(phase==='callback'?1:2);
 }finally{resume.release();if(pending)await Promise.allSettled([pending]);await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60_000);

test.skipIf(!databaseUrl)('runtime persists separate exact-scope grants, targets owned current tracks once and leaves cleanup/feedback untouched',async()=>{
 const db=new Database(databaseUrl!,`test_playback_http_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined;
 let profileId=owner,expandedScope=false,failWrite=false;
 const sdkScopes=['streaming','user-read-email','user-read-private'];
 const controlScopes=['user-read-playback-state','user-modify-playback-state','user-read-private'];
 const calls:{path:string;method:string;authorization:string|null;body:unknown}[]=[];
 const deviceId='controlled/device?one';
 const cards=[1,2,3,4].map(n=>row(n).track);
 cards[1]={...cards[1]!,isPlayable:false};
 const playbackTransport=new PlaybackTransport({fetch:async(url,init)=>{
  const parsed=new URL(url),method=init?.method??'GET',authorization=new Headers(init?.headers).get('authorization');
  const body=typeof init?.body==='string'?JSON.parse(init.body):init?.body instanceof URLSearchParams?Object.fromEntries(init.body):null;
  calls.push({path:parsed.pathname+parsed.search,method,authorization,body});
  if(parsed.pathname==='/api/token'){
   const code=(body as Record<string,string>).code,purpose=code==='control-code'?'control':'sdk';
   return Response.json({access_token:`controlled-${purpose}-access`,refresh_token:`controlled-${purpose}-refresh`,token_type:'Bearer',expires_in:3600,
    scope:[...(purpose==='sdk'?sdkScopes:controlScopes),...(expandedScope?['user-library-read']:[])].join(' ')});
  }
  if(parsed.pathname==='/v1/me')return Response.json({id:profileId,product:'premium'});
  if(parsed.pathname==='/v1/me/player/devices')return Response.json({devices:[{id:deviceId,is_restricted:false}]});
  if(method==='PUT'){
   if(failWrite)return Response.json({error:{message:'private-control-provider-detail'}},{status:503});
   return new Response(null,{status:204});
  }
  if(parsed.pathname==='/v1/me/player')return new Response(null,{status:204});
  throw Error('Unexpected controlled playback request');
 }});
 let primaryCalls=0;
 try{
  await migrate(db);
  runtime=await buildRuntime({env:config(db.schema),spotifyHttp:new SpotifyHttp({fetch:async url=>{primaryCalls++;return primaryProvider(url);}}),playbackTransport});
  expect(runtime.startupIssues).toEqual([]);
  const app=runtime.app,cookies=await login(runtime),headers={origin:webOrigin};
  const post=(url:string,payload:Record<string,unknown>={})=>app.inject({method:'POST',url,cookies,headers,payload});
  const repo=new Repository(db),now=new Date().toISOString();
  await repo.upsertSavedTracks(cards.slice(0,3).map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'})));
  const foreignId='spotify:controlled.other';
  await repo.upsertUser({id:foreignId,spotifyId:'controlled.other',displayName:'Controlled Other',avatarUrl:null},true);
  await repo.upsertSavedTracks([{userId:foreignId,track:cards[3]!,originalAddedAt:cards[3]!.originalAddedAt,syncedAt:now,currentStatus:'saved'}]);
  // A completed current-membership snapshot retains track 3 only in history.
  const jobId=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO library_state(user_id,job_id,pass,source_total,observed_at) VALUES(${userId},${jobId},0,2,${now})`;
   for(const card of cards.slice(0,2))await tx`INSERT INTO library_membership(user_id,track_id,job_id,pass) VALUES(${userId},${card.trackId},${jobId},0)`;
  });
  const pendingPrimary=await app.inject('/api/auth/spotify/start');
  const pendingCookies=Object.fromEntries(pendingPrimary.cookies.map(c=>[c.name,c.value]));
  const stableSnapshot=()=>db.transaction(async tx=>{
   const tables=['users','oauth_credentials','auth_sessions','oauth_attempts','library_membership','library_state','saved_tracks','review_decisions','undo_commands','calibration_labels','calibration_undos','feedback_sync_jobs','feedback','exposures','interaction_events','model_runs'];
   const result:Record<string,unknown>={};
   for(const table of tables)result[table]=await tx.unsafe(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`);
   return result;
  });
  const baseline=await stableSnapshot(),primaryBeforePlayback=primaryCalls;
  const connect=async(purpose:'sdk'|'control',returnTo:'review'|'calibration'='calibration')=>{
   const start=await post('/api/player/connect',{returnTo});expect(start.statusCode).toBe(200);
   expect(Object.keys(start.json())).toEqual(['authorizationUrl']);
   const url=new URL(start.json().authorizationUrl),state=url.searchParams.get('state')!;
   expect(state).toMatch(new RegExp(`^playback-${purpose}\\.[A-Za-z0-9_-]{43}$`));
   expect(url.searchParams.get('scope')!.split(' ')).toEqual(purpose==='sdk'?sdkScopes:controlScopes);
   expect(url.searchParams.get('redirect_uri')).toBe(`${apiOrigin}/api/auth/spotify/callback`);
   expect(url.searchParams.get('code_challenge_method')).toBe('S256');
   const cookie=start.cookies[0]!;
   expect(cookie).toMatchObject({name:`__Host-sortfm_playback_${purpose}`,httpOnly:true,secure:true,path:'/',sameSite:'Lax'});
   expect(cookie.domain).toBeUndefined();
   const callback=()=>app.inject({url:`/api/auth/spotify/callback?${new URLSearchParams({state,code:`${purpose}-code`,ubi:'ignored'})}`,cookies:{...cookies,...pendingCookies,[cookie.name]:cookie.value}});
   return {callback,cookie,state};
  };
  const initial=await app.inject({url:'/api/player/connection',cookies});
  expect(PlaybackConnectionStatusSchema.parse(initial.json())).toMatchObject({status:'reconnect_required',sdkReady:false,controlReady:false});
  expect((await post('/api/player/token')).json().code).toBe('PLAYBACK_RECONNECT_REQUIRED');
  expect(calls).toHaveLength(0);
  expandedScope=true;
  const expanded=await(await connect('sdk')).callback();expect(expanded.statusCode).toBe(403);expect(expanded.json().code).toBe('PLAYBACK_SCOPE_REJECTED');
  expandedScope=false;profileId='controlled.other';
  const foreign=await(await connect('sdk')).callback();expect(foreign.statusCode).toBe(403);expect(foreign.json().code).toBe('ACCOUNT_NOT_ALLOWED');
  profileId=owner;
  const sdk=await connect('sdk'),sdkCallback=await sdk.callback();
  expect(sdkCallback.statusCode).toBe(302);expect(sdkCallback.headers.location).toBe(`${webOrigin}/#/calibrate`);
  expect(sdkCallback.cookies.map(c=>c.name)).toEqual([sdk.cookie.name]);expect(sdkCallback.cookies[0]!.maxAge).toBe(0);
  const beforeReplay=calls.length;
  expect((await sdk.callback()).json().code).toBe('OAUTH_STATE_INVALID');expect(calls).toHaveLength(beforeReplay);
  expect((await app.inject({url:'/api/player/connection',cookies})).json()).toMatchObject({sdkReady:true,controlReady:false});
  const control=await connect('control','review'),controlCallback=await control.callback();
  expect(controlCallback.statusCode).toBe(302);expect(controlCallback.headers.location).toBe(`${webOrigin}/#/review`);
  expect(controlCallback.cookies.map(c=>c.name)).toEqual([control.cookie.name]);
  expect((await app.inject({url:'/api/player/connection',cookies})).json()).toEqual({status:'ready',sdkReady:true,controlReady:true,reason:null});
  expect((await post('/api/player/connect',{returnTo:'review'})).statusCode).toBe(409);
  const issued=await post('/api/player/token'),token=PlaybackSdkTokenSchema.parse(issued.json());
  expect(issued.statusCode).toBe(200);expect(token).toMatchObject({ownerId:userId,accessToken:'controlled-sdk-access',scopes:sdkScopes,tokenType:'Bearer'});
  expect(Date.parse(token.expiresAt)).toBeGreaterThan(Date.now());
  expect(Object.keys(token).sort()).toEqual(['accessToken','expiresAt','ownerId','scopes','tokenType']);
  expect(issued.headers).toMatchObject({'cache-control':'no-store','referrer-policy':'no-referrer','access-control-allow-origin':webOrigin,'access-control-allow-credentials':'true'});
  for(const forbidden of ['controlled-primary-access','controlled-primary-refresh','controlled-control-access','controlled-control-refresh','controlled-sdk-refresh'])expect(issued.body).not.toContain(forbidden);
  const persisted=await db.transaction(tx=>tx`SELECT payload FROM playback_grants ORDER BY purpose`);
  expect(persisted).toHaveLength(2);
  for(const grant of persisted){expect(grant.payload.encryptedAccessToken).toStartWith('v1.');expect(grant.payload.encryptedRefreshToken).toStartWith('v1.');}
  expect(JSON.stringify(persisted)).not.toContain('controlled-sdk-access');
  expect((await app.inject({method:'POST',url:'/api/player/token',payload:{},headers})).statusCode).toBe(401);
  expect((await app.inject({method:'POST',url:'/api/player/token',payload:{},cookies})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url:'/api/player/token',payload:{},cookies,headers:{origin:'https://foreign.example'}})).statusCode).toBe(403);
  expect((await post('/api/player/token',{ownerId:foreignId})).statusCode).toBe(400);
  expect((await post('/api/player/token?ownerId=foreign')).statusCode).toBe(400);
  expect((await app.inject({url:'/api/player/status',cookies})).json()).toMatchObject({available:false,isPlaying:false,deviceId:null,trackUri:null});
  expect(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  // Retained saves are not current-library evidence before any completed import.
  await db.transaction(tx=>tx`DELETE FROM library_state WHERE user_id=${userId}`);
  expect(await repo.library(userId)).toHaveLength(3); // Preserve the shared legacy projection.
  const withoutSnapshot=await post('/api/player/sdk/play',{trackUri:cards[0]!.spotifyUri,deviceId});
  expect(withoutSnapshot.statusCode).toBe(422);expect(withoutSnapshot.json().code).toBe('PLAYBACK_TRACK_UNAVAILABLE');
  expect(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  await db.transaction(tx=>tx`INSERT INTO library_state(user_id,job_id,pass,source_total,observed_at) VALUES(${userId},${jobId},0,2,${now})`);
  expect((await post('/api/player/sdk/play',{trackUri:cards[0]!.spotifyUri})).statusCode).toBe(400);
  for(const track of cards.slice(1)){
   const rejected=await post('/api/player/sdk/play',{trackUri:track.spotifyUri,deviceId});
   expect(rejected.statusCode).toBe(422);expect(rejected.json().code).toBe('PLAYBACK_TRACK_UNAVAILABLE');
  }
  expect(calls.filter(c=>c.method==='PUT')).toHaveLength(0);
  const played=await post('/api/player/sdk/play',{trackUri:cards[0]!.spotifyUri,deviceId});
  expect(played.statusCode).toBe(200);expect(played.json()).toEqual({ok:true});
  expect(calls.filter(c=>c.method==='PUT')).toEqual([{path:'/v1/me/player/play?device_id=controlled%2Fdevice%3Fone',method:'PUT',authorization:'Bearer controlled-control-access',body:{uris:[cards[0]!.spotifyUri]}}]);
  const transferred=await post('/api/player/transfer',{deviceId});expect(transferred.statusCode).toBe(200);
  expect(calls.filter(c=>c.method==='PUT').at(-1)).toEqual({path:'/v1/me/player',method:'PUT',authorization:'Bearer controlled-control-access',body:{device_ids:[deviceId],play:false}});
  failWrite=true;
  const uncertain=await post('/api/player/sdk/play',{trackUri:cards[0]!.spotifyUri,deviceId});
  expect(uncertain.statusCode).toBe(503);expect(uncertain.json()).toMatchObject({code:'PLAYBACK_OUTCOME_UNKNOWN',retryable:false});expect(uncertain.body).not.toContain('private-control-provider-detail');
  expect(calls.filter(c=>c.method==='PUT')).toHaveLength(3);
  expect(primaryCalls).toBe(primaryBeforePlayback);
  expect(await stableSnapshot()).toEqual(baseline);
  // The untouched primary attempt still completes normally, replacing only login state.
  const primaryState=new URL(String(pendingPrimary.headers.location)).searchParams.get('state')!;
  const ordinary=await app.inject({url:`/api/auth/spotify/callback?${new URLSearchParams({state:primaryState,code:'primary-code'})}`,cookies:pendingCookies});
  expect(ordinary.statusCode).toBe(302);expect(ordinary.headers.location).toBe(webOrigin);
  expect(ordinary.cookies.some(c=>c.name==='__Host-sortfm_session')).toBe(true);
  const callsBeforeExpired=calls.length;
  const invalidated=await post('/api/player/token');expect(invalidated.statusCode).toBe(401);expect(invalidated.json().code).toBe('AUTHENTICATION_REQUIRED');expect(calls).toHaveLength(callsBeforeExpired);
 }finally{await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},90_000);

for(const invalidation of ['logout','expiry'] as const)test.skipIf(!databaseUrl)(`playback callback and token issuance reject primary session ${invalidation} before provider I/O`,async()=>{
 const db=new Database(databaseUrl!,`test_playback_session_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined,playbackCalls=0;
 try{
  await migrate(db);
  runtime=await buildRuntime({env:config(db.schema),spotifyHttp:new SpotifyHttp({fetch:primaryProvider}),
   playbackTransport:new PlaybackTransport({fetch:async()=>{playbackCalls++;throw Error('Invalidated session must not reach the provider');}}),
  });
  expect(runtime.startupIssues).toEqual([]);
  const app=runtime.app,cookies=await login(runtime);
  const start=await app.inject({method:'POST',url:'/api/player/connect',cookies,headers:{origin:webOrigin},payload:{returnTo:'calibration'}});
  expect(start.statusCode).toBe(200);
  const state=new URL(start.json().authorizationUrl).searchParams.get('state')!,purposeCookie=start.cookies[0]!;
  if(invalidation==='logout')expect((await app.inject({method:'POST',url:'/api/auth/logout',cookies,headers:{origin:webOrigin},payload:{}})).statusCode).toBe(200);
  else await db.transaction(tx=>tx`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=${userId}`);
  const callback=await app.inject({url:`/api/auth/spotify/callback?${new URLSearchParams({state,code:'must-not-exchange'})}`,cookies:{...cookies,[purposeCookie.name]:purposeCookie.value}});
  expect(callback.statusCode).toBe(401);expect(callback.json().code).toBe('AUTHENTICATION_REQUIRED');
  expect(callback.cookies.map(c=>c.name)).toEqual([purposeCookie.name]);
  const token=await app.inject({method:'POST',url:'/api/player/token',cookies,headers:{origin:webOrigin},payload:{}});
  expect(token.statusCode).toBe(401);expect(token.json().code).toBe('AUTHENTICATION_REQUIRED');
  expect(playbackCalls).toBe(0);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM playback_grants`)).toHaveLength(0);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM playback_oauth_attempts WHERE consumed_at IS NOT NULL OR completed_at IS NOT NULL`)).toHaveLength(0);
 }finally{await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60_000);
