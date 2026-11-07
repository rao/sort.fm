import {z,ZodError} from 'zod';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {CalibrationLabelRequestSchema,CalibrationQueueQuerySchema,PUBLIC_ROUTES,UndoRequestSchema,UuidSchema} from '@sortfm/contracts';
import {CalibrationError,invalidResponse} from './errors';
import type {CalibrationService} from './service';
import type {CalibrationQueue} from './queue';
export interface CalibrationModuleOptions {
 config:{secureCookies:boolean;webOrigin:string;apiOrigin:string};
 /** Existing owner session lookup; write scopes and provider credentials are irrelevant. */
 auth:{session(token?:string):Promise<{user:{id:string}}|null>};
 service:Pick<CalibrationService,'label'|'undo'|'history'>;
 queue:Pick<CalibrationQueue,'get'>;
}
const missing=new Set(['USER_NOT_FOUND','TRACK_NOT_OWNED','EXPOSURE_NOT_FOUND','CALIBRATION_LABEL_NOT_FOUND']);
const conflicts=new Set(['TRACK_NOT_IN_LIBRARY','CALIBRATION_NOT_ELIGIBLE','CALIBRATION_LABEL_ACTIVE','STALE_CALIBRATION_LABEL','MUTATION_PENDING','EXPOSURE_TRACK_MISMATCH','EXPOSURE_PURPOSE_MISMATCH','EXPOSURE_ALREADY_CONSUMED','STALE_EXPOSURE','EXPOSURE_CONFLICT','IDEMPOTENCY_CONFLICT']);
function publicError(error:unknown):CalibrationError {
 if(error instanceof CalibrationError)return error;
 if(error instanceof ZodError)return new CalibrationError('VALIDATION_ERROR','Request does not match the shared contract.',400);
 const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
 if(missing.has(code))return new CalibrationError(code,'The requested calibration resource is unavailable.',404);
 if(conflicts.has(code))return new CalibrationError(code,'The preference conflicts with current state. Refresh calibration before submitting a new label.',409);
 if(['AUTHENTICATION_REQUIRED','SPOTIFY_REAUTH_REQUIRED'].includes(code))return new CalibrationError('AUTHENTICATION_REQUIRED','Connect an authorized account.',401);
 if(code==='ACCOUNT_NOT_ALLOWED')return new CalibrationError(code,'This account is not authorized.',403);
 return new CalibrationError('CALIBRATION_UNAVAILABLE','Calibration could not be completed. Retry with the same request key.',503,true);
}

/** Separate namespace and session/CSRF checks; no cleanup service, worker or Spotify client. */
export function createCalibrationModule(options:CalibrationModuleOptions){
 const empty=z.strictObject({}),cookie=options.config.secureCookies?'__Host-sortfm_session':'sortfm_session';
 const allowed=(origin:string)=>[options.config.webOrigin,options.config.apiOrigin].includes(origin);
 async function owner(req:FastifyRequest){
  const matches=(req.headers.cookie??'').split(';').map(s=>s.trim()).filter(s=>s.slice(0,s.indexOf('='))===cookie);
  let token:string|undefined;
  if(matches.length===1)try{token=decodeURIComponent(matches[0]!.slice(cookie.length+1));}catch{/* Invalid cookies are anonymous. */}
  if(!token)throw new CalibrationError('AUTHENTICATION_REQUIRED','Connect an authorized account.',401);
  const account=await options.auth.session(token);
  if(!account)throw new CalibrationError('AUTHENTICATION_REQUIRED','Connect an authorized account.',401);
  return account.user.id;
 }
 function csrf(req:FastifyRequest){
  if(!req.headers.origin||!allowed(req.headers.origin)||req.headers['sec-fetch-site']==='cross-site')throw new CalibrationError('CSRF_REJECTED','This request must originate from sort.fm.',403);
 }
 async function backend<T>(call:()=>Promise<T>):Promise<T>{
  try{return await call();}catch(error){if(error instanceof ZodError)throw invalidResponse();throw error;}
 }
 function safe(handler:(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>){
  return async(req:FastifyRequest,reply:FastifyReply)=>{
   reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
   try{
    if(req.headers.origin&&!allowed(req.headers.origin))throw new CalibrationError('ORIGIN_NOT_ALLOWED','Origin is not allowed.',403);
    return await handler(req,reply);
   }catch(error){
    const safe=publicError(error);
    if(safe.statusCode>=500)req.log.error({code:safe.code},'Calibration operation failed');
    return reply.code(safe.statusCode).send({code:safe.code,message:safe.message,retryable:safe.retryable});
   }
  };
 }
 const registerRoutes=async(app:FastifyInstance)=>{
  app.get(PUBLIC_ROUTES.calibrationQueue.path,safe(async req=>{
   const query=CalibrationQueueQuerySchema.parse(req.query);if(req.body!==undefined)empty.parse(req.body);
   const userId=await owner(req);return backend(()=>options.queue.get(userId,query));
  }));
  app.post(PUBLIC_ROUTES.calibrationLabel.path,safe(async req=>{
   csrf(req);empty.parse(req.query);const request=CalibrationLabelRequestSchema.parse(req.body),userId=await owner(req);
   return backend(()=>options.service.label(userId,request));
  }));
  app.post(PUBLIC_ROUTES.calibrationUndo.path,safe(async req=>{
   csrf(req);empty.parse(req.query);const {id}=z.strictObject({id:UuidSchema}).parse(req.params),request=UndoRequestSchema.parse(req.body),userId=await owner(req);
   return backend(()=>options.service.undo(userId,id,request));
  }));
  app.get(PUBLIC_ROUTES.calibrationHistory.path,safe(async req=>{
   empty.parse(req.query);if(req.body!==undefined)empty.parse(req.body);
   const userId=await owner(req);return backend(()=>options.service.history(userId));
  }));
 };
 return {registerRoutes};
}
