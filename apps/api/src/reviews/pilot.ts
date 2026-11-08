import {z,ZodError} from 'zod';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {PUBLIC_ROUTES,CalibrationCorrectionRequestSchema,QueueQuerySchema,ReviewRequestSchema,UndoRequestSchema,UuidSchema,type ExposureInput} from '@sortfm/contracts';
import {SpotifyError} from '../spotify/errors';
import {reviewRouteSecurity,type ReviewRouteOptions} from './module';
import type {ReviewRepository} from './store';

/** All reads MUST use D's immutable pilot-fenced repository, including replay lookups.
 * getPublishedExposure proves exact persisted publication/binding/payload membership;
 * a normal getExposure implementation is insufficient. Atomic writes repeat this fence.
 */
export interface PilotAdmissionPort extends Pick<ReviewRepository,'getDecisionByIdempotencyKey'|'getDecision'|'getUndoByIdempotencyKey'> {
 getPublishedExposure(userId:string,exposureId:string):Promise<ExposureInput|null>;
}
const denied=()=>new SpotifyError('PILOT_ACTION_NOT_ALLOWED','This action is not enabled for this pilot.',403,false);
const conflict=()=>new SpotifyError('IDEMPOTENCY_CONFLICT','This request key was already used for a different action.',409,false);
const publicReads=new Set<string>([PUBLIC_ROUTES.health.path,PUBLIC_ROUTES.authStart.path,PUBLIC_ROUTES.authCallback.path]);
const privateReads=new Set<string>([PUBLIC_ROUTES.me.path,PUBLIC_ROUTES.queue.path,PUBLIC_ROUTES.history.path,PUBLIC_ROUTES.librarySummary.path,PUBLIC_ROUTES.insights.path,PUBLIC_ROUTES.analytics.path,PUBLIC_ROUTES.calibrationHistory.path]);
const posts=new Set<string>([PUBLIC_ROUTES.logout.path,PUBLIC_ROUTES.decide.path,PUBLIC_ROUTES.undo.path,PUBLIC_ROUTES.calibrationCorrection.path,PUBLIC_ROUTES.calibrationUndo.path]);
const expectedDenials=new Set(['REVIEW_EXPOSURE_NOT_PUBLISHED','REVIEW_TRACK_EXCLUDED','REVIEW_OWNER_MISMATCH','REVIEW_ACTION_NOT_ALLOWED']);
const empty=z.strictObject({});

/** Install in buildApp.beforeRoutes, never inside an encapsulated child plugin.
 * This is an HTTP admission layer, not a substitute for the immutable DB fence,
 * isolated worker state, disabled importer startup and explicit mutation opt-in.
 */
export function installPilotGuards(app:FastifyInstance,options:ReviewRouteOptions & {admission:PilotAdmissionPort;allowSpotifyMutations?:boolean}):void {
 const security=reviewRouteSecurity(options),repo=options.admission;
 const actions=new Set(options.allowSpotifyMutations===true?['KEEP','ARCHIVE','SKIP','UNLIKE']:['KEEP','SKIP']);
 const safe=(handler:(request:FastifyRequest)=>Promise<void>)=>async(request:FastifyRequest,reply:import('fastify').FastifyReply)=>{
  reply.header('Referrer-Policy','no-referrer');
  try {await handler(request);} catch(error) {
   const code=error && typeof error==='object' && 'code' in error?String(error.code):'';
   const result=error instanceof ZodError?new SpotifyError('VALIDATION_ERROR','Request does not match the shared contract.',400,false)
    :expectedDenials.has(code)?denied():code==='IDEMPOTENCY_CONFLICT'?conflict():error instanceof SpotifyError?error
    :new SpotifyError('PILOT_ADMISSION_UNAVAILABLE','Pilot admission is temporarily unavailable.',503,true);
   return reply.code(result.statusCode).send(result.envelope());
  }
 };
 async function published(userId:string,exposureId:string,trackId:string) {
  const row=await repo.getPublishedExposure(userId,exposureId);
  if(!row || row.userId!==userId || row.exposure.exposureId!==exposureId || row.exposure.trackId!==trackId)throw denied();
 }
 // Match the registered route template and method, not a permissive URL prefix.
 // Unknown routes and automatically generated HEAD handlers are denied as well.
 app.addHook('onRequest',safe(async request=>{
  const path=request.routeOptions.url;
  if(!path || !(request.method==='GET' && (publicReads.has(path)||privateReads.has(path)) || request.method==='POST' && posts.has(path)))throw denied();
  if(path===PUBLIC_ROUTES.authCallback.path){
   const query=z.object({state:z.string().max(128).optional()}).parse(request.query);
   if(query.state?.startsWith('playback-'))throw denied();
  }
 }));
 app.addHook('preValidation',safe(async request=>{
  const path=request.routeOptions.url!;
  if(publicReads.has(path))return;
  if(request.method==='POST')security.csrf(request);
  const userId=await security.owner(request);
  if(path===PUBLIC_ROUTES.queue.path && QueueQuerySchema.parse(request.query).mode!=='spotify')throw denied();
  if(request.method!=='POST')return;
  empty.parse(request.query);
  if(path===PUBLIC_ROUTES.logout.path){empty.parse(request.body??{});return;}
  if(path===PUBLIC_ROUTES.decide.path){
   const input=ReviewRequestSchema.parse(request.body);
   if(!actions.has(input.action))throw denied();
   const old=await repo.getDecisionByIdempotencyKey(userId,input.idempotencyKey);
   if(old && (old.idempotencyKey!==input.idempotencyKey || old.trackId!==input.trackId || old.exposureId!==input.exposureId || old.action!==input.action || old.mode!=='spotify'))throw conflict();
   await published(userId,input.exposureId,input.trackId);
   return;
  }
  // Preference corrections use the published original Skip and D repeats all
  // eligibility checks under the owner lock. No Spotify mutation is admitted here.
  if(path===PUBLIC_ROUTES.calibrationCorrection.path){
   const input=CalibrationCorrectionRequestSchema.parse(request.body),decision=await repo.getDecision(userId,input.decisionId);
   if(!decision||decision.decisionId!==input.decisionId||decision.mode!=='spotify'||decision.action!=='SKIP')throw denied();
   await published(userId,decision.exposureId,decision.trackId);return;
  }
  if(path===PUBLIC_ROUTES.calibrationUndo.path){
   z.strictObject({id:UuidSchema}).parse(request.params);UndoRequestSchema.parse(request.body);
   // The fenced calibration store restricts history/Undo to correction provenance.
   return;
  }
  const {id}=z.strictObject({id:UuidSchema}).parse(request.params),input=UndoRequestSchema.parse(request.body);
  const old=await repo.getUndoByIdempotencyKey(userId,input.idempotencyKey);
  if(old && (old.userId!==userId || old.decisionId!==id || old.request.idempotencyKey!==input.idempotencyKey))throw conflict();
  const decision=await repo.getDecision(userId,id);
  if(!decision || decision.decisionId!==id || decision.mode!=='spotify' || !actions.has(decision.action))throw denied();
  await published(userId,decision.exposureId,decision.trackId);
 }));
}
