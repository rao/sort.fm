import {z,ZodError} from 'zod';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {DecisionHistorySchema,ReviewRequestSchema,ReviewResultSchema,UndoRequestSchema,UuidSchema,QueueQuerySchema, QueueResultSchema, type QueueResult} from '@sortfm/contracts';
import {authenticationRequired, safeError, SpotifyError} from '../spotify/errors';
import type {QueueService} from './queue';
import type {ReviewService} from './service';

export interface ReviewRouteOptions {
  config:{secureCookies:boolean;webOrigin:string;apiOrigin:string};
  auth:{session(token?:string):Promise<{user:{id:string}}|null>};
}
export function reviewRouteSecurity({config,auth}:ReviewRouteOptions) {
  const sessionName=config.secureCookies?'__Host-sortfm_session':'sortfm_session';
  async function owner(request:FastifyRequest):Promise<string> {
    const matches=(request.headers.cookie??'').split(';').map(part=>part.trim()).filter(part=>part.slice(0,part.indexOf('='))===sessionName);
    let token:string|undefined;
    if(matches.length===1) {try {token=decodeURIComponent(matches[0]!.slice(sessionName.length+1));} catch { /* Invalid cookie is anonymous. */ }}
    const account=await auth.session(token); if(!account) throw authenticationRequired(); return account.user.id;
  }
  function csrf(request:FastifyRequest) {
    if(!request.headers.origin || ![config.webOrigin,config.apiOrigin].includes(request.headers.origin) || request.headers['sec-fetch-site']==='cross-site') throw new SpotifyError('CSRF_REJECTED','This request must originate from sort.fm.',403);
  }
  function safe(handler:(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>) {
    return async(req:FastifyRequest,reply:FastifyReply)=>{
      reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
      try {
        if(req.headers.origin && ![config.webOrigin,config.apiOrigin].includes(req.headers.origin)) throw new SpotifyError('ORIGIN_NOT_ALLOWED','Origin is not allowed.',403);
        return await handler(req,reply);
      } catch(error) {
        const conflicts=['IDEMPOTENCY_CONFLICT','MUTATION_PENDING','STATE_CONFLICT','STALE_DECISION','STALE_EXPOSURE','EXPOSURE_ALREADY_CONSUMED','EXPOSURE_TRACK_MISMATCH','EXPOSURE_NOT_FOUND','REVIEW_LEASE_REQUIRED','REVIEW_LEASE_LOST','TRACK_NOT_OWNED','TRACK_NOT_IN_LIBRARY'];
        const code=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
        const safe=error instanceof ZodError?new SpotifyError('VALIDATION_ERROR','Request does not match the shared contract.',400):conflicts.includes(code)?new SpotifyError(code,'The action conflicts with current review state. Refresh the queue.',409):safeError(error);
        if(safe.retryAt)reply.header('Retry-After',String(Math.max(1,Math.ceil((safe.retryAt-Date.now())/1000))));
        if(!(error instanceof ZodError) && !(error instanceof SpotifyError)) req.log.error({code:safe.code},'Review operation failed');
        return reply.code(safe.statusCode).send(safe.envelope());
      }
    };
  }
  return {owner,csrf,safe};
}
export function createReviewQueueModule(options:ReviewRouteOptions & {queue:QueueService;demoQueue?:(query:ReturnType<typeof QueueQuerySchema.parse>)=>QueueResult|Promise<QueueResult>}) {
  const security=reviewRouteSecurity(options);
  const registerRoutes=async(app:FastifyInstance)=>{
    app.get('/api/queue',security.safe(async(req)=>{
      const query=QueueQuerySchema.parse(req.query);
      if(query.mode==='demo') {
        if(!options.demoQueue) throw new SpotifyError('DEMO_DISABLED','Demo mode is not enabled.',404);
        return QueueResultSchema.parse(await options.demoQueue(query));
      }
      return options.queue.get(await security.owner(req),query);
    }));
  };
  return {registerRoutes};
}


/** Install only with D recovery persistence and a live worker; scopes are opt-in here. */
export function createReviewMutationModule(options:ReviewRouteOptions & {service:ReviewService;worker:{start():void;close():Promise<void>};enableWrites:()=>void}) {
  const security=reviewRouteSecurity(options),empty=z.strictObject({});
  const registerRoutes=async(app:FastifyInstance)=>{
    app.post('/api/decisions',security.safe(async(req,reply)=>{
      security.csrf(req);empty.parse(req.query);const userId=await security.owner(req);
      const result=ReviewResultSchema.parse(await options.service.decide(userId,ReviewRequestSchema.parse(req.body)));
      return reply.code(['PENDING','FAILED_RETRYABLE'].includes(result.status)?202:200).send(result);
    }));
    app.post('/api/decisions/:id/undo',security.safe(async(req)=>{
      security.csrf(req);empty.parse(req.query);const userId=await security.owner(req);
      const {id}=z.strictObject({id:UuidSchema}).parse(req.params);
      return ReviewResultSchema.parse(await options.service.undo(userId,id,UndoRequestSchema.parse(req.body)));
    }));
    app.get('/api/decisions/history',security.safe(async(req)=>{empty.parse(req.query);return DecisionHistorySchema.parse(await options.service.history(await security.owner(req)));}));
    options.enableWrites();
    app.addHook('onReady',async()=>{options.worker.start();});
    app.addHook('onClose',async()=>{await options.worker.close();});
  };
  return {registerRoutes};
}
