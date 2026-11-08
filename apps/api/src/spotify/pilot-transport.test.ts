import {expect,test} from 'bun:test';
import {createPilotOAuthFetch,denyPilotProviderFetch,createPilotPlaybackTransport} from './pilot-transport';
import {SpotifyHttp} from './http';
import {SpotifyMutations} from './mutations';
test('OAuth transport permits only exact token/profile endpoints and disables redirects',async()=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const guarded=createPilotOAuthFetch(async(url,init)=>{calls.push({url,init});return Response.json({ok:true});});
 const signal=new AbortController().signal;
 for(const grant of ['authorization_code','refresh_token'])await guarded('https://accounts.spotify.com/api/token',{method:'POST',body:new URLSearchParams({grant_type:grant}),signal,redirect:'follow'});
 await guarded('https://api.spotify.com/v1/me');
 expect(calls).toHaveLength(3);expect(calls[0]!.init?.signal).toBe(signal);expect(calls.every(c=>c.init?.redirect==='error')).toBe(true);
 for(const [url,method,body] of [
  ['https://api.spotify.com/v1/me/tracks','GET'],['https://api.spotify.com/v1/me/player','GET'],['https://api.spotify.com/v1/me/library','DELETE'],
  ['https://api.spotify.com/v1/me?x=y','GET'],['https://api.spotify.com/v1/me#x','GET'],['https://api.spotify.com/v1/%6de','GET'],['https://evil.test/v1/me','GET'],
  ['https://api.spotify.com/v1/me','POST'],['https://accounts.spotify.com/api/token','GET'],['https://accounts.spotify.com/api/token','POST',new URLSearchParams({grant_type:'client_credentials'})],
  ['https://accounts.spotify.com/api/token','POST',new URLSearchParams('grant_type=refresh_token&grant_type=authorization_code')],
 ] as const)await expect(guarded(url,{method,body})).rejects.toMatchObject({code:'PILOT_ACTION_NOT_ALLOWED',statusCode:403,retryable:false});
 expect(calls).toHaveLength(3);
});
test('denied OAuth transport fails without retrying; mutation denial has known rejected outcome',async()=>{
 let calls=0,sleeps=0;
 const http=new SpotifyHttp({fetch:createPilotOAuthFetch(async()=>{calls++;return Response.json({});}),sleep:async()=>{sleeps++;}});
 await expect(http.json('https://api.spotify.com/v1/me/tracks')).rejects.toMatchObject({code:'PILOT_ACTION_NOT_ALLOWED'});
 expect(calls).toBe(0);expect(sleeps).toBe(0);
 const mutations=new SpotifyMutations({accessToken:async()=>({token:'synthetic',version:'v1'}),requireScopes:async()=>{},revoke:async()=>false},new SpotifyHttp({fetch:denyPilotProviderFetch}),{fetch:denyPilotProviderFetch});
 await expect(mutations.setLiked('spotify:owner','0000000000000000000001',false)).rejects.toMatchObject({outcome:'rejected',retryable:false});
 await expect(mutations.isLiked('spotify:owner','0000000000000000000001')).rejects.toMatchObject({code:'SPOTIFY_FORBIDDEN',retryable:false});
 for(const url of ['https://accounts.spotify.com/api/token','https://api.spotify.com/v1/me','https://api.spotify.com/v1/me/library']){
  expect((await denyPilotProviderFetch(url,{method:'PUT'})).status).toBe(403);
 }
});
test('playback transport has no network implementation for tokens, reads or writes',async()=>{
 const transport=createPilotPlaybackTransport();
 await expect(transport.token(new URLSearchParams({grant_type:'authorization_code'}))).rejects.toMatchObject({code:'PLAYBACK_UNAVAILABLE'});
 await expect(transport.api('/me/player','synthetic')).rejects.toMatchObject({code:'PLAYBACK_SCOPE_REJECTED'});
 await expect(transport.api('/me/player/play','synthetic',{method:'PUT'})).rejects.toMatchObject({code:'PLAYBACK_SCOPE_REJECTED'});
});
