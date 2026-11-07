import {z} from 'zod';
import {PLAYBACK_SDK_SCOPES,PLAYBACK_CONTROL_SCOPES,PlaybackSdkScopesSchema,PlaybackControlScopesSchema,PlaybackConnectRequestSchema,PlaybackSdkTokenSchema,IdSchema,UuidSchema,type PlaybackStore,type PlaybackGrant,type PlaybackGrantPurpose,type PlaybackSessionContext,type PlaybackConnectRequest,type PlaybackConnectionStatus} from '@sortfm/contracts';
import type {SpotifyConfig} from '../auth/config';
import {TokenCipher,digest,newSecret,pkceChallenge,sessionHash} from '../auth/crypto';
import {authenticationRequired,SpotifyError} from '../spotify/errors';
import {PlaybackError} from './errors';
import {PlaybackTransport} from './transport';
export type PlaybackPrimaryAuth={session(token?:string):Promise<{user:{id:string;spotifyId:string|null}}|null>};
export type PlaybackCallbackQuery={state?:string;code?:string;error?:string};
const tokenSchema=z.object({access_token:z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),refresh_token:z.string().min(1).optional(),token_type:z.string().refine(x=>x.toLowerCase()==='bearer'),expires_in:z.number().int().positive().max(86400),scope:z.string().optional()});
const stateError=()=>new SpotifyError('OAUTH_STATE_INVALID','Playback authorization expired or could not be verified. Start again.',400);
export function playbackPurpose(state?:string):PlaybackGrantPurpose|null{const m=/^playback-(sdk|control)\.[A-Za-z0-9_-]{43}$/.exec(state??'');return m?m[1] as PlaybackGrantPurpose:null;}
export class PlaybackService {
 private readonly cipher:TokenCipher;readonly transport:PlaybackTransport;
 constructor(private readonly options:{config:SpotifyConfig;store:PlaybackStore;auth:PlaybackPrimaryAuth;transport?:PlaybackTransport;sleep?:(ms:number)=>Promise<void>}){
  this.cipher=new TokenCipher(options.config.encryptionKey);this.transport=options.transport??new PlaybackTransport();
 }
 private now(){return this.transport.now();}
 private current(context:PlaybackSessionContext){return {...context,now:this.now()};}
 async context(raw?:string):Promise<PlaybackSessionContext>{
  if(!raw||!/^[\w-]{43}$/.test(raw))throw authenticationRequired();
  const account=await this.options.auth.session(raw);if(!account)throw authenticationRequired();
  const id=account.user.spotifyId;
  if(!id||!this.options.config.allowedUserIds.has(id)||account.user.id!==`spotify:${id}`)throw new SpotifyError('ACCOUNT_NOT_ALLOWED','This account is not authorized.',403);
  return {ownerId:account.user.id,initiatingSessionHash:sessionHash(raw,this.options.config.sessionSecret),now:this.now()};
 }
 private scopes(purpose:PlaybackGrantPurpose,value:unknown){const result=(purpose==='sdk'?PlaybackSdkScopesSchema:PlaybackControlScopesSchema).safeParse(value);if(!result.success)throw new PlaybackError('PLAYBACK_SCOPE_REJECTED');return result.data;}
 private checkGrant(grant:PlaybackGrant,context:PlaybackSessionContext,purpose:PlaybackGrantPurpose){
  if(grant.ownerId!==context.ownerId||grant.purpose!==purpose||!UuidSchema.safeParse(grant.credentialVersion).success||!Number.isSafeInteger(grant.expiresAt)||grant.expiresAt<=0)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
  if(grant.revoked||!grant.encryptedAccessToken||!grant.encryptedRefreshToken)throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  this.scopes(purpose,grant.scopes);
 }
 private open(grant:PlaybackGrant,kind:'access'|'refresh'){try{return this.cipher.open(kind==='access'?grant.encryptedAccessToken:grant.encryptedRefreshToken,`${grant.ownerId}:playback:${grant.purpose}:${kind}`);}catch{throw new PlaybackError('PLAYBACK_UNAVAILABLE');}}
 async connection(raw?:string):Promise<PlaybackConnectionStatus>{
  const context=await this.context(raw),ready:boolean[]=[];
  for(const purpose of ['sdk','control'] as const){const grant=await this.options.store.getGrant({...this.current(context),purpose});
   if(!grant||grant.revoked){ready.push(false);continue;}this.checkGrant(grant,context,purpose);ready.push(true);
  }
  return ready.every(Boolean)?{status:'ready',sdkReady:true,controlReady:true,reason:null}:{status:'reconnect_required',sdkReady:ready[0]!,controlReady:ready[1]!,reason:'Connect the remaining playback permissions.'};
 }
 async connect(raw:string|undefined,input:PlaybackConnectRequest){
  const request=PlaybackConnectRequestSchema.parse(input),context=await this.context(raw);
  let purpose:PlaybackGrantPurpose|undefined,old:PlaybackGrant|null=null;
  for(const candidate of ['sdk','control'] as const){const grant=await this.options.store.getGrant({...this.current(context),purpose:candidate});
   if(!grant||grant.revoked){purpose=candidate;old=grant;break;}this.checkGrant(grant,context,candidate);
  }
  if(!purpose)throw new SpotifyError('STATE_CONFLICT','Playback permissions are already connected.',409);
  const state=`playback-${purpose}.${newSecret()}`,browserToken=newSecret(),verifier=newSecret(),stateHash=digest(state);
  const c=this.options.config;
  await this.options.store.createOAuth({stateHash,purpose,ownerId:context.ownerId,initiatingSessionHash:context.initiatingSessionHash,browserHash:digest(browserToken),
   encryptedVerifier:this.cipher.seal(verifier,`${context.ownerId}:playback:${purpose}:oauth:${stateHash}`),returnTo:request.returnTo,createdAt:this.now(),expiresAt:this.now()+c.oauthTtlMs,expectedCredentialVersion:old?.credentialVersion??null},this.now());
  const url=new URL('https://accounts.spotify.com/authorize');url.search=new URLSearchParams({response_type:'code',client_id:c.clientId,redirect_uri:c.redirectUri,
   scope:(purpose==='sdk'?PLAYBACK_SDK_SCOPES:PLAYBACK_CONTROL_SCOPES).join(' '),state,code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)}).toString();
  return {authorizationUrl:url.toString(),browserToken,purpose};
 }
 private tokens(value:unknown,purpose:PlaybackGrantPurpose,prior?:PlaybackGrant){
  const result=tokenSchema.safeParse(value);if(!result.success)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
  const tokens=result.data,scopes=this.scopes(purpose,tokens.scope===undefined?prior?.scopes:tokens.scope.trim().split(/\s+/));
  if(!prior&&!tokens.refresh_token)throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  return {tokens,scopes};
 }
 private async profile(token:string,ownerId:string){
  const parsed=z.object({id:IdSchema,product:z.string().optional()}).safeParse(await this.transport.api('/me',token));
  if(!parsed.success)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
  if(`spotify:${parsed.data.id}`!==ownerId||!this.options.config.allowedUserIds.has(parsed.data.id))throw new SpotifyError('ACCOUNT_NOT_ALLOWED','Playback must use the connected account.',403);
  if(['free','open'].includes(parsed.data.product??''))throw new PlaybackError('PLAYBACK_PREMIUM_REQUIRED');
 }
 private makeGrant(ownerId:string,purpose:PlaybackGrantPurpose,value:ReturnType<PlaybackService['tokens']>,issuedAt:number,prior?:PlaybackGrant):PlaybackGrant{
  if(issuedAt+value.tokens.expires_in*1000<=this.now())throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  return {ownerId,purpose,scopes:value.scopes,encryptedAccessToken:this.cipher.seal(value.tokens.access_token,`${ownerId}:playback:${purpose}:access`),
   encryptedRefreshToken:value.tokens.refresh_token?this.cipher.seal(value.tokens.refresh_token,`${ownerId}:playback:${purpose}:refresh`):prior!.encryptedRefreshToken,
   expiresAt:issuedAt+value.tokens.expires_in*1000,credentialVersion:crypto.randomUUID(),revoked:false,refreshLease:null} as PlaybackGrant;
 }
 async callback(query:PlaybackCallbackQuery,browserToken?:string,raw?:string){
  const purpose=playbackPurpose(query.state);if(!purpose||!browserToken||!/^[\w-]{43}$/.test(browserToken))throw stateError();
  const context=await this.context(raw),stateHash=digest(query.state!);
  let attempt;
  try{attempt=await this.options.store.consumeOAuth({...this.current(context),stateHash,purpose,browserHash:digest(browserToken)});}catch(error){
   // Persistence errors are structural: keep the DB independent of API classes,
   // and preserve only the explicit live-primary-session failure with fixed text.
   if(error&&typeof error==='object'&&'code'in error&&error.code==='AUTHENTICATION_REQUIRED')throw authenticationRequired();
   if(error instanceof SpotifyError)throw error;
   throw stateError();
  }
  if(attempt.ownerId!==context.ownerId||attempt.purpose!==purpose||attempt.initiatingSessionHash!==context.initiatingSessionHash||attempt.stateHash!==stateHash)throw stateError();
  if(query.error)throw new SpotifyError('OAUTH_ACCESS_DENIED','Playback authorization was declined.',400);
  if(!query.code||query.code.length>4096)throw new SpotifyError('OAUTH_CODE_REQUIRED','Spotify did not return an authorization code.',400);
  const verifier=this.cipher.open(attempt.encryptedVerifier,`${context.ownerId}:playback:${purpose}:oauth:${stateHash}`),issuedAt=this.now();
  const parsed=this.tokens(await this.transport.token(new URLSearchParams({grant_type:'authorization_code',client_id:this.options.config.clientId,redirect_uri:this.options.config.redirectUri,code:query.code,code_verifier:verifier})),purpose);
  await this.profile(parsed.tokens.access_token,context.ownerId);
  const fresh=await this.context(raw);
  if(!await this.options.store.completeOAuth({...fresh,stateHash,grant:this.makeGrant(context.ownerId,purpose,parsed,issuedAt)}))throw new SpotifyError('STATE_CONFLICT','A newer playback authorization superseded this attempt. Connect again.',409);
  return attempt.returnTo;
 }
 async credential(raw:string|undefined,purpose:PlaybackGrantPurpose):Promise<{token:string;grant:PlaybackGrant;context:PlaybackSessionContext}>{
  const context=await this.context(raw),deadline=this.now()+5000;let cycles=0;
  for(;;){
   if(++cycles>100)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
   const grant=await this.options.store.getGrant({...this.current(context),purpose});if(!grant)throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');this.checkGrant(grant,context,purpose);
   // The provider may issue tokens shorter than a conventional refresh skew.
   // Reuse genuinely unexpired grants so concurrent/staggered callers do not
   // rotate each other's tokens. Issuance and commands recheck expiry after I/O.
   if(grant.expiresAt>this.now())return {token:this.open(grant,'access'),grant,context};
   if(this.now()>=deadline)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
   const fence={...this.current(context),purpose,expectedCredentialVersion:grant.credentialVersion,leaseId:crypto.randomUUID()};
   const claimed=await this.options.store.claimRefresh({...fence,leaseUntil:this.now()+60000});
   if(!claimed){if(this.now()>=deadline)throw new PlaybackError('PLAYBACK_UNAVAILABLE');await (this.options.sleep??Bun.sleep)(100);continue;}
   let exchanged=false;
   try{
    this.checkGrant(claimed,context,purpose);const issuedAt=this.now();
    const response=await this.transport.token(new URLSearchParams({grant_type:'refresh_token',client_id:this.options.config.clientId,refresh_token:this.open(claimed,'refresh')}));
    exchanged=true;const parsed=this.tokens(response,purpose,claimed);
    await this.profile(parsed.tokens.access_token,context.ownerId);
    const replacement=this.makeGrant(context.ownerId,purpose,parsed,issuedAt,claimed);
    const fresh=await this.context(raw);
    if(!await this.options.store.completeRefresh({...fence,...fresh,grant:replacement})){
     await this.options.store.revokeGrant({...fence,now:this.now()});throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
    }
    // Re-read under the live session and validate before the token crosses any boundary.
   }catch(error){
    // A lost/invalid refresh response may have rotated the provider credential. Never
    // replay that exchange or fall back to the primary grant. Rate limits are definite rejection.
    if(exchanged||!(error instanceof PlaybackError&&error.code==='PLAYBACK_RATE_LIMITED'))await this.options.store.revokeGrant({...fence,now:this.now()});
    throw error;
   }finally{await this.options.store.releaseRefresh({...fence,now:this.now()});}
  }
 }
 async sdkToken(raw?:string){
  const {token,grant}=await this.credential(raw,'sdk');
  try{await this.profile(token,grant.ownerId);}catch(error){if(error instanceof PlaybackError&&error.code==='PLAYBACK_RECONNECT_REQUIRED'&&grant.expiresAt>this.now())await this.options.store.revokeGrant({ownerId:grant.ownerId,purpose:'sdk',expectedCredentialVersion:grant.credentialVersion,now:this.now()});throw error;}
  const context=await this.context(raw),latest=await this.options.store.getGrant({...context,purpose:'sdk'});
  if(!latest||latest.credentialVersion!==grant.credentialVersion)throw new PlaybackError('PLAYBACK_UNAVAILABLE');this.checkGrant(latest,context,'sdk');
  if(latest.expiresAt<=this.now())throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  return PlaybackSdkTokenSchema.parse({ownerId:context.ownerId,accessToken:token,tokenType:'Bearer',expiresAt:new Date(latest.expiresAt).toISOString(),scopes:latest.scopes});
 }
 /** Recheck after preflight I/O, immediately before issuing a command or returning state. */
 async assertCurrent(raw:string|undefined,grant:PlaybackGrant){
  const context=await this.context(raw),latest=await this.options.store.getGrant({...context,purpose:grant.purpose});
  if(!latest||latest.credentialVersion!==grant.credentialVersion)throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  this.checkGrant(latest,context,grant.purpose);
  if(latest.expiresAt<=this.now())throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
 }
 // Expiry is recoverable by refresh. Reject this request, but never discard the
 // refresh credential or replay a control command for normal access-token expiry.
 async rejectControl(grant:PlaybackGrant){if(grant.expiresAt<=this.now())return;await this.options.store.revokeGrant({ownerId:grant.ownerId,purpose:'control',expectedCredentialVersion:grant.credentialVersion,now:this.now()});}
}
