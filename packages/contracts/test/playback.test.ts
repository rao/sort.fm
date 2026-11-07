import {expect,test} from 'bun:test';
import * as contracts from '../src/index';
import {ApiError,createApiClient} from '../src/client';

const ownerId='spotify:fixture.owner';
const trackUri=`spotify:track:${'0'.repeat(22)}`;
const deviceId='fixture-device-01';
const scopes:contracts.PlaybackSdkScope[]=['streaming','user-read-email','user-read-private'];
const credential=():contracts.PlaybackSdkToken=>({ownerId,accessToken:crypto.randomUUID(),tokenType:'Bearer',expiresAt:new Date(Date.now()+60_000).toISOString(),scopes});
const connection:contracts.PlaybackConnectionStatus={status:'ready',sdkReady:true,controlReady:true,reason:null};
const authorizationUrl='https://accounts.spotify.com/authorize?response_type=code&state=fixture';

test('SDK routes are owner-only and preserve existing player DTOs',()=>{
 expect('PlaybackSdkTokenSchema' in contracts).toBe(true);
 for(const [key,path] of [['playbackConnection','/api/player/connection'],['playbackConnect','/api/player/connect'],
  ['playbackToken','/api/player/token'],['playbackPlay','/api/player/sdk/play'],['playbackTransfer','/api/player/transfer']] as const){
  expect(contracts.PUBLIC_ROUTES[key].path).toBe(path);expect(contracts.PUBLIC_ROUTES[key].auth).toBe('owner');
 }
 expect(contracts.PlayRequestSchema.parse({trackUri})).toEqual({trackUri});
 expect(contracts.PlayerStatusSchema.parse({available:true,deviceId,isPlaying:false,trackUri:null,reason:null})).toEqual({available:true,deviceId,isPlaying:false,trackUri:null,reason:null});
});

test('SDK token response accepts only the exact scope set and no other credentials',()=>{
 const valid=credential();expect(contracts.PlaybackSdkTokenSchema.parse(valid)).toEqual(valid);
 expect(contracts.PlaybackSdkTokenSchema.safeParse({...valid,scopes:[...scopes].reverse()}).success).toBe(true);
 for(const invalid of [scopes.slice(0,2),[...scopes,'user-library-modify'],[...scopes,'user-modify-playback-state'],
  ['streaming','streaming','user-read-private'],[]])expect(contracts.PlaybackSdkTokenSchema.safeParse({...valid,scopes:invalid}).success).toBe(false);
 for(const patch of [{refreshToken:crypto.randomUUID()},{clientSecret:crypto.randomUUID()},{scope:scopes.join(' ')},
  {tokenType:'Basic'},{expiresAt:'later'},{accessToken:''},{accessToken:'invalid credential'},{ownerId:'other/user'}])
  expect(contracts.PlaybackSdkTokenSchema.safeParse({...valid,...patch}).success).toBe(false);
 expect(contracts.AccountSessionSchema.safeParse({mode:'anonymous',user:null,capabilities:{spotifyRead:false,spotifyWrite:false,playback:false},accessToken:valid.accessToken}).success).toBe(false);
});

test('SDK play and transfer require one explicit opaque device and reject client authority',()=>{
 expect(contracts.PlaybackPlayRequestSchema.parse({trackUri,deviceId})).toEqual({trackUri,deviceId});
 expect(contracts.PlaybackTransferRequestSchema.parse({deviceId})).toEqual({deviceId});
 for(const invalid of ['', ' ', 'device\nheader', 'd'.repeat(513)]){
  expect(contracts.PlaybackPlayRequestSchema.safeParse({trackUri,deviceId:invalid}).success).toBe(false);
 }
 for(const patch of [{deviceId:undefined},{trackUri:'spotify:album:0000000000000000000001'},
  {ownerId:'other'},{positionMs:1},{contextUri:trackUri},{accessToken:crypto.randomUUID()}])
  expect(contracts.PlaybackPlayRequestSchema.safeParse({trackUri,deviceId,...patch}).success).toBe(false);
 expect(contracts.PlaybackTransferRequestSchema.safeParse({deviceId,play:true}).success).toBe(false);
 expect(contracts.PlaybackTransferRequestSchema.safeParse({deviceIds:[deviceId]}).success).toBe(false);
});

test('server control grant accepts only playback control and same-owner profile scopes',()=>{
 const control=['user-read-playback-state','user-modify-playback-state','user-read-private'];
 expect(contracts.PlaybackControlScopesSchema.safeParse(control).success).toBe(true);
 for(const invalid of [control.slice(0,2),[...control,'user-read-email'],[...control,'streaming'],[...control,'user-library-read'],[control[0],control[0],control[2]]])
  expect(contracts.PlaybackControlScopesSchema.safeParse(invalid).success).toBe(false);
 expect(contracts.PlaybackSdkScopesSchema.safeParse(control).success).toBe(false);
});

test('connect destinations and authorization origin cannot be supplied as arbitrary URLs or scopes',()=>{
 for(const returnTo of ['review','calibration'])expect(contracts.PlaybackConnectRequestSchema.safeParse({returnTo}).success).toBe(true);
 for(const patch of [{returnTo:'https://example.test'},{returnTo:'#/calibrate'},{scope:'user-library-modify'},{purpose:'sdk'},{ownerId}])
  expect(contracts.PlaybackConnectRequestSchema.safeParse({returnTo:'review',...patch}).success).toBe(false);
 expect(contracts.PlaybackConnectResponseSchema.parse({authorizationUrl})).toEqual({authorizationUrl});
 for(const url of ['http://accounts.spotify.com/authorize','https://accounts.spotify.com.evil.test/authorize',
  'https://accounts.spotify.com@evil.test/authorize','https://accounts.spotify.com/other','https://accounts.spotify.com/authorize#credential',
  'https://accounts.spotify.com/authorize?response_type=token'])
  expect(contracts.PlaybackConnectResponseSchema.safeParse({authorizationUrl:url}).success).toBe(false);
 expect(contracts.PlaybackEmptyRequestSchema.safeParse({ownerId}).success).toBe(false);
});

test('connection readiness is separate from device playback and cannot contradict grant state',()=>{
 expect(contracts.PlaybackConnectionStatusSchema.parse(connection)).toEqual(connection);
 expect(contracts.PlaybackConnectionStatusSchema.safeParse({status:'reconnect_required',sdkReady:true,controlReady:false,reason:'Connect playback control.'}).success).toBe(true);
 for(const patch of [{sdkReady:false},{controlReady:false},{reason:'not ready'},{isPlaying:true},{accessToken:crypto.randomUUID()}])
  expect(contracts.PlaybackConnectionStatusSchema.safeParse({...connection,...patch}).success).toBe(false);
 expect(contracts.PlaybackConnectionStatusSchema.safeParse({...connection,status:'reconnect_required',reason:'Reconnect.'}).success).toBe(false);
 for(const status of ['premium_required','unavailable'])expect(contracts.PlaybackConnectionStatusSchema.safeParse({...connection,status,reason:'Playback unavailable.'}).success).toBe(true);
 for(const code of ['PLAYBACK_PREMIUM_REQUIRED','PLAYBACK_RECONNECT_REQUIRED','PLAYBACK_UNAVAILABLE'])
  expect(contracts.PlaybackErrorEnvelopeSchema.safeParse({code,message:'Playback unavailable.',retryable:false}).success).toBe(true);
 expect(contracts.PlaybackErrorEnvelopeSchema.safeParse({code:'provider-private-message',message:'Unknown'}).success).toBe(false);
});

test('browser playback client targets frozen endpoints and never places credentials in requests',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[],issued=credential();
 const client=createApiClient({baseUrl:'https://api.example.test/',fetch:(async(input,init)=>{
  const url=String(input);calls.push({url,init});
  return Response.json(url.endsWith('/token')?issued:url.endsWith('/connection')?connection:url.endsWith('/connect')?{authorizationUrl}:
   url.endsWith('/status')?{available:false,deviceId:null,isPlaying:false,trackUri:null,reason:'No active device.'}:{ok:true});
 }) as typeof fetch});
 await client.playbackConnection();await client.connectPlayback({returnTo:'calibration'});
 expect(await client.playbackToken(ownerId)).toEqual(issued);
 await client.playOnDevice({trackUri,deviceId});await client.transferPlayback({deviceId});await client.playerStatus();
 expect(calls.map(c=>[c.url,c.init?.method])).toEqual([
  ['https://api.example.test/api/player/connection','GET'],['https://api.example.test/api/player/connect','POST'],
  ['https://api.example.test/api/player/token','POST'],['https://api.example.test/api/player/sdk/play','POST'],
  ['https://api.example.test/api/player/transfer','POST'],['https://api.example.test/api/player/status','GET']]);
 expect(calls.every(c=>c.init?.credentials==='include')).toBe(true);
 expect(calls[2]!.init).toMatchObject({cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',body:'{}'});
 expect(JSON.stringify(calls)).not.toContain(issued.accessToken);
 expect(()=>client.playOnDevice({trackUri,deviceId,userId:'other'} as contracts.PlaybackPlayRequest)).toThrow();
 expect(calls).toHaveLength(6);
});

test('token client refuses changed owners, expired credentials and broad scopes without exposing payloads',async()=>{
 for(const patch of [{ownerId:'spotify:other'},{expiresAt:'2000-01-01T00:00:00.000Z'},{scopes:[...scopes,'user-library-read']},{refreshToken:crypto.randomUUID()}]){
  const issued={...credential(),...patch};
  const client=createApiClient({fetch:(async()=>Response.json(issued)) as unknown as typeof fetch});
  let failure:unknown;try{await client.playbackToken(ownerId);}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(ApiError);expect(String(failure)).not.toContain(issued.accessToken);expect(JSON.stringify(failure)).not.toContain(issued.accessToken);
 }
});

test('token client sanitizes valid error envelopes and transport exceptions and never retries POST',async()=>{
 for(const kind of ['known','unknown','transport']){
  const privateDetail=crypto.randomUUID();let count=0;
  const client=createApiClient({fetch:(async()=>{count++;if(kind==='transport')throw Error(privateDetail);
   return Response.json({code:kind==='known'?'PLAYBACK_RECONNECT_REQUIRED':privateDetail,message:privateDetail,retryable:true},{status:503});}) as unknown as typeof fetch});
  let failure:unknown;try{await client.playbackToken(ownerId);}catch(error){failure=error;}
  expect(count).toBe(1);expect(failure).toBeInstanceOf(Error);expect(String(failure)).not.toContain(privateDetail);expect(JSON.stringify(failure)).not.toContain(privateDetail);
 }
});

test('play and transfer acknowledge requests without claiming playback or replaying ambiguous writes',async()=>{
 let count=0;const client=createApiClient({fetch:(async()=>{count++;return Response.json({code:'PLAYBACK_OUTCOME_UNKNOWN',message:'Check playback before retrying.',retryable:false},{status:503});}) as unknown as typeof fetch});
 await expect(client.playOnDevice({trackUri,deviceId})).rejects.toMatchObject({error:{code:'PLAYBACK_OUTCOME_UNKNOWN'}});
 await expect(client.transferPlayback({deviceId})).rejects.toMatchObject({error:{code:'PLAYBACK_OUTCOME_UNKNOWN'}});expect(count).toBe(2);
 expect(contracts.PUBLIC_ROUTES.playbackPlay.response.safeParse({ok:true,isPlaying:true}).success).toBe(false);
});
