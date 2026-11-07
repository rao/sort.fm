import {ZodError} from 'zod';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {PUBLIC_ROUTES,PlaybackEmptyRequestSchema,PlaybackConnectRequestSchema,PlaybackConnectResponseSchema,PlaybackConnectionStatusSchema,PlaybackPlayRequestSchema,PlaybackTransferRequestSchema,PlaybackSdkTokenSchema,PlayerStatusSchema,PlaybackErrorCodeSchema,OkSchema} from '@sortfm/contracts';
import type {SpotifyConfig} from '../auth/config';
import {SpotifyError} from '../spotify/errors';
import {PlaybackError} from './errors';
import {PlaybackService,type PlaybackCallbackQuery} from './service';
import {PlaybackControls} from './controls';
import {playbackCookie,readCookie} from './cookies';

/** Do not serialize adapter/provider messages, even when they carry a recognized code. */
function publicError(error:unknown):SpotifyError{
 const code=error&&typeof error==='object'&&'code'in error?error.code:null,playback=PlaybackErrorCodeSchema.safeParse(code);
 if(playback.success)return new PlaybackError(playback.data,error instanceof PlaybackError?error.retryAt:null);
 const fixed:Record<string,[number,string]>={
  AUTHENTICATION_REQUIRED:[401,'Connect an authorized Spotify account.'],ACCOUNT_NOT_ALLOWED:[403,'Playback must use the connected account.'],
  OAUTH_STATE_INVALID:[400,'Playback authorization expired or could not be verified. Start again.'],OAUTH_ACCESS_DENIED:[400,'Playback authorization was declined.'],
  OAUTH_CODE_REQUIRED:[400,'Spotify did not return an authorization code.'],STATE_CONFLICT:[409,'Playback authorization changed. Check connection state before trying again.'],
  CSRF_REJECTED:[403,'This request must originate from sort.fm.'],ORIGIN_NOT_ALLOWED:[403,'Origin is not allowed.'],VALIDATION_ERROR:[400,'Request does not match the shared contract.'],
 };
 const known=typeof code==='string'?fixed[code]:undefined;
 return known?new SpotifyError(code as string,known[1],known[0]):new PlaybackError('PLAYBACK_UNAVAILABLE');
}
/** Explicit dependencies only; no production memory store or primary-token fallback. */
export function createPlaybackModule(options:{config:SpotifyConfig;service:PlaybackService;controls:PlaybackControls}){
 const {config,service,controls}=options;
 const session=(req:FastifyRequest)=>readCookie(req.headers.cookie,`${config.secureCookies?'__Host-':''}sortfm_session`);
 const callback=async(query:PlaybackCallbackQuery,browserToken?:string,raw?:string)=>{try{return await service.callback(query,browserToken,raw);}catch(error){throw publicError(error);}};
 type Handler=(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>;
 const safe=(handler:Handler):Handler=>async(req,reply)=>{
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
  try{
   const origin=req.headers.origin;
   if(origin&&![config.webOrigin,config.apiOrigin].includes(origin))throw new SpotifyError('ORIGIN_NOT_ALLOWED','',403);
   if(req.method==='POST'&&(!origin||req.headers['sec-fetch-site']==='cross-site'))throw new SpotifyError('CSRF_REJECTED','',403);
   PlaybackEmptyRequestSchema.parse(req.query);
   return await handler(req,reply);
  }catch(error){
   const exposed=publicError(error instanceof ZodError?new SpotifyError('VALIDATION_ERROR','',400):error);
   if(exposed.retryAt)reply.header('Retry-After',String(Math.max(1,Math.ceil((exposed.retryAt-service.transport.now())/1000))));
   if(!(error instanceof SpotifyError)&&!(error instanceof ZodError))req.log.error({code:exposed.code},'Playback operation failed');
   return reply.code(exposed.statusCode).send(exposed.envelope());
  }
 };
 // Keep provider/adapter output validation separate from request validation errors.
 const result=async<T>(work:()=>Promise<T>)=>{try{return await work();}catch(error){throw publicError(error);}};
 const registerRoutes=async(app:FastifyInstance)=>{
  app.get(PUBLIC_ROUTES.playbackConnection.path,safe(async req=>result(async()=>PlaybackConnectionStatusSchema.parse(await service.connection(session(req))))));
  app.post(PUBLIC_ROUTES.playbackConnect.path,safe(async(req,reply)=>{
   const input=PlaybackConnectRequestSchema.parse(req.body);
   return result(async()=>{const start=await service.connect(session(req),input);reply.header('Set-Cookie',playbackCookie(config.secureCookies,start.purpose,start.browserToken,config.oauthTtlMs/1000));return PlaybackConnectResponseSchema.parse({authorizationUrl:start.authorizationUrl});});
  }));
  app.post(PUBLIC_ROUTES.playbackToken.path,safe(async req=>{PlaybackEmptyRequestSchema.parse(req.body??{});return result(async()=>PlaybackSdkTokenSchema.parse(await service.sdkToken(session(req))));}));
  app.post(PUBLIC_ROUTES.playbackPlay.path,safe(async req=>{const input=PlaybackPlayRequestSchema.parse(req.body);return result(async()=>OkSchema.parse(await controls.play(session(req),input)));}));
  app.post(PUBLIC_ROUTES.playbackTransfer.path,safe(async req=>{const input=PlaybackTransferRequestSchema.parse(req.body);return result(async()=>OkSchema.parse(await controls.transfer(session(req),input)));}));
  app.get(PUBLIC_ROUTES.playerStatus.path,safe(async req=>result(async()=>PlayerStatusSchema.parse(await controls.status(session(req))))));
 };
 return {registerRoutes,callback};
}
