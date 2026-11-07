import {PLAYBACK_SDK_SCOPES,PLAYBACK_CONTROL_SCOPES} from '@sortfm/contracts';
import {loadSpotifyConfig} from '../auth/config';
import {sessionHash} from '../auth/crypto';
import {PlaybackService} from './service';
import {PlaybackTransport} from './transport';
import {PlaybackTestStore,owner,sessionToken} from './test-support';
export const config=loadSpotifyConfig({SPOTIFY_CLIENT_ID:'client',SPOTIFY_ALLOWED_USER_IDS:'owner',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'z'.repeat(40)});
export function fixture(){
 let clock=Date.parse('2026-11-07T12:00:00Z'),purpose:'sdk'|'control'='sdk',scope:string|undefined,profileId='owner';
 const store=new PlaybackTestStore();store.sessionHash=sessionHash(sessionToken,config.sessionSecret);
 const calls:{url:string;init?:RequestInit}[]=[];
 let intercept:((url:string,init?:RequestInit)=>Promise<Response|undefined>)|undefined;
 const transport=new PlaybackTransport({now:()=>clock,fetch:async(url,init)=>{
  calls.push({url,init});const result=await intercept?.(url,init);if(result)return result;
  if(url.endsWith('/api/token'))return Response.json({access_token:`${purpose}-access`,refresh_token:`${purpose}-refresh`,token_type:'Bearer',expires_in:3600,scope:scope??(purpose==='sdk'?PLAYBACK_SDK_SCOPES:PLAYBACK_CONTROL_SCOPES).join(' ')});
  return Response.json({id:profileId,product:'premium'});
 }});
 const auth={session:async(token?:string)=>store.live&&token===sessionToken?{user:{id:owner,spotifyId:'owner'}}:null};
 const service=new PlaybackService({config,store,transport,auth,sleep:async()=>{await Bun.sleep(1);clock++;}});
 const connect=async()=>{const s=await service.connect(sessionToken,{returnTo:'calibration'});purpose=s.purpose;await service.callback({state:new URL(s.authorizationUrl).searchParams.get('state')!,code:'code'},s.browserToken,sessionToken);return s;};
 return {store,service,transport,config,calls,connect,advance:(ms:number)=>{clock+=ms;},setScope:(s:string)=>{scope=s;},setProfile:(s:string)=>{profileId=s;},intercept:(f:typeof intercept)=>{intercept=f;}};
}
