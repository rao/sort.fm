import {expect,test} from 'bun:test';
import {PlaybackControls} from './controls';
import {fixture} from './fixtures';
import {sessionToken} from './test-support';
import {row} from '../calibration/test-fixtures';
const track=row(1).track,device='sdk/device?opaque';
async function setup(){const f=fixture();await f.connect();await f.connect();const controls=new PlaybackControls(f.service,{track:async()=>track});return {...f,controls};}

test('exact card URI and SDK device are sent once with isolated control grant; transfer remains explicit',async()=>{
 const f=await setup();const writes:{url:string;body:unknown}[]=[];
 f.intercept(async(url,init)=>{
  expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer control-access');
  if(url.endsWith('/devices'))return Response.json({devices:[{id:device,is_restricted:false}]});
  writes.push({url,body:JSON.parse(init?.body as string)});return new Response(null,{status:204});
 });
 expect(await f.controls.play(sessionToken,{trackUri:track.spotifyUri!,deviceId:device})).toEqual({ok:true});
 expect(writes).toEqual([{url:`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device)}`,body:{uris:[track.spotifyUri]}}]);
 expect(await f.controls.transfer(sessionToken,{deviceId:device})).toEqual({ok:true});expect(writes[1]!.body).toEqual({device_ids:[device],play:false});
});

test('missing/restricted devices and foreign/unplayable tracks never issue a control command',async()=>{
 const f=await setup();let writes=0;
 f.intercept(async(_url,init)=>{if(init?.method==='PUT')writes++;return Response.json({devices:[{id:device,is_restricted:true}]});});
 await expect(f.controls.play(sessionToken,{trackUri:track.spotifyUri!,deviceId:device})).rejects.toMatchObject({code:'PLAYBACK_DEVICE_RESTRICTED'});
 await expect(f.controls.play(sessionToken,{trackUri:track.spotifyUri!,deviceId:'missing'})).rejects.toMatchObject({code:'PLAYBACK_DEVICE_UNAVAILABLE'});
 for(const result of [null,{...track,isPlayable:false}])await expect(new PlaybackControls(f.service,{track:async()=>result}).play(sessionToken,{trackUri:track.spotifyUri!,deviceId:device})).rejects.toMatchObject({code:'PLAYBACK_TRACK_UNAVAILABLE'});
 expect(writes).toBe(0);
});

test('logout during device lookup fences writes; provider401 revokes only control and never replays',async()=>{
 const f=await setup();let writes=0;
 f.intercept(async(_url,init)=>{if(init?.method==='PUT')writes++;f.store.live=false;return Response.json({devices:[{id:device,is_restricted:false}]});});
 await expect(f.controls.transfer(sessionToken,{deviceId:device})).rejects.toMatchObject({code:'AUTHENTICATION_REQUIRED'});expect(writes).toBe(0);
 const g=await setup();g.intercept(async(_url,init)=>{if(init?.method==='PUT'){writes++;return new Response(null,{status:401});}return Response.json({devices:[{id:device,is_restricted:false}]});});
 await expect(g.controls.play(sessionToken,{trackUri:track.spotifyUri!,deviceId:device})).rejects.toMatchObject({code:'PLAYBACK_RECONNECT_REQUIRED'});expect(writes).toBe(1);
 expect([...g.store.grants.values()].find(v=>v.purpose==='control')!.revoked).toBe(true);expect([...g.store.grants.values()].find(v=>v.purpose==='sdk')!.revoked).toBe(false);expect(g.store.live).toBe(true);
});

test('playback status reflects provider state;204 means no active device and errors are not success',async()=>{
 const f=await setup();f.intercept(async()=>new Response(null,{status:204}));expect(await f.controls.status(sessionToken)).toMatchObject({available:false,isPlaying:false,trackUri:null});
 f.intercept(async()=>Response.json({device:{id:device,is_restricted:false},is_playing:true,item:{uri:track.spotifyUri}}));expect(await f.controls.status(sessionToken)).toMatchObject({available:true,deviceId:device,isPlaying:true,trackUri:track.spotifyUri});
 f.intercept(async()=>Response.json({device:{id:device,is_restricted:true},is_playing:false,item:null}));expect(await f.controls.status(sessionToken)).toMatchObject({available:false,isPlaying:false,reason:expect.any(String)});
});

test('expiry during control preflight or provider command preserves refresh without replaying the command',async()=>{
 for(const expiresDuring of ['preflight','command']){
  const f=await setup();const grant=[...f.store.grants.values()].find(g=>g.purpose==='control')!;
  grant.expiresAt=f.transport.now()+1000;let writes=0;
  f.intercept(async(_url,init)=>{
   if(init?.method==='PUT'){writes++;f.advance(1001);return new Response(null,{status:401});}
   if(expiresDuring==='preflight')f.advance(1001);
   return Response.json({devices:[{id:device,is_restricted:false}]});
  });
  await expect(f.controls.transfer(sessionToken,{deviceId:device})).rejects.toMatchObject({code:'PLAYBACK_RECONNECT_REQUIRED'});
  expect(writes).toBe(expiresDuring==='preflight'?0:1);expect(grant.revoked).toBe(false);
  f.intercept(undefined);expect((await f.service.credential(sessionToken,'control')).token).toBe('control-access');
 }
});
