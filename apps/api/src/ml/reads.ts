/** Owner-scoped model/analytics reads. No scoring, training or provider mutations. */
import {z, type ZodType} from 'zod';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {
  AudioFeatureStatusSchema, LibrarySummarySchema, ModelMetricsSchema, ModelRunInputSchema, PUBLIC_ROUTES,
  type AudioFeatureStatus, type LibrarySummary, type ModelMetrics, type ModelRunInput,
} from '@sortfm/contracts';
import {reviewRouteSecurity, type ReviewRouteOptions} from '../reviews/module';
import {SpotifyError} from '../spotify/errors';
import type {RepositoryMl} from './repository';

export interface MlReadOptions extends ReviewRouteOptions {
  getSummary(userId:string):Promise<LibrarySummary>;
  audioProgress(userId:string):Promise<AudioFeatureStatus>;
  ml:Pick<RepositoryMl,'evaluation'>|null;
  /** D's owner-scoped recorded run, when available. Missing does not mean untrained. */
  latestModel?(userId:string):Promise<ModelRunInput|null>;
  /** Bounds waiting for each read. Underlying adapters own cancellation and I/O deadlines. */
  readTimeoutMs?:number;
}

function unavailable(code='ML_UNAVAILABLE'):SpotifyError {
  return new SpotifyError(code,'The requested information is unavailable. Retry later.',503,true);
}

/** Dependency validation failures are server failures, not malformed client input. */
function checked<S extends ZodType>(schema:S,value:unknown,code:string):z.output<S> {
  const parsed=schema.safeParse(value);
  if(!parsed.success)throw unavailable(code);
  return parsed.data;
}

export function createMlReadModule(options:MlReadOptions) {
  const security=reviewRouteSecurity(options),empty=z.strictObject({});
  const timeoutMs=options.readTimeoutMs??2000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2_147_483_647)
    throw new RangeError('readTimeoutMs must be a positive timer-safe integer.');

  async function bounded<T>(read:()=>Promise<T>):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(unavailable('SERVICE_UNAVAILABLE')),timeoutMs);}),
      ]);
    } finally {clearTimeout(timer);}
  }

  async function data<S extends ZodType>(schema:S,read:()=>Promise<unknown>,code:string):Promise<z.output<S>> {
    try {return checked(schema,await bounded(read),code);}
    catch {throw unavailable(code);}
  }

  async function metrics(userId:string):Promise<ModelMetrics> {
    if(options.ml){
      try {return checked(ModelMetricsSchema,await bounded(()=>options.ml!.evaluation(userId)),'ML_UNAVAILABLE');}
      catch { /* Only a recorded, validated run can provide historical counts on failure. */ }
    }
    try {
      const saved=options.latestModel?await bounded(()=>options.latestModel!(userId)):null;
      if(saved===null)throw unavailable();
      const run=checked(ModelRunInputSchema,saved,'ML_UNAVAILABLE');
      if(run.userId!==userId||run.modelVersion!==run.metrics.modelVersion||run.trainedExamples!==run.metrics.trainedExamples)
        throw unavailable();
      return checked(ModelMetricsSchema,{
        ...run.metrics,
        status:'unavailable',
        reason:'ML service is unavailable. Counts and model version describe the last recorded model run and may be stale.',
        baseRate:null,balancedAccuracy:null,rocAuc:null,prAuc:null,logLoss:null,brierScore:null,precisionAtK:null,
      },'ML_UNAVAILABLE');
    } catch {throw unavailable();}
  }

  async function owner(request:FastifyRequest):Promise<string> {
    empty.parse(request.query);
    // Fastify does not parse GET bodies; inspect framing as well as parsed input.
    if(request.body!==undefined||request.headers['transfer-encoding']!==undefined
      ||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0'))
      throw new SpotifyError('VALIDATION_ERROR','These read endpoints do not accept a request body.',400);
    return bounded(()=>security.owner(request));
  }

  const registerRoutes=async(app:FastifyInstance)=>{
    app.get(PUBLIC_ROUTES.insights.path,security.safe(async request=>{
      const userId=await owner(request);
      const [evaluation,audio]=await Promise.all([
        metrics(userId),
        data(AudioFeatureStatusSchema,()=>options.audioProgress(userId),'AUDIO_STATUS_UNAVAILABLE'),
      ]);
      // This route has no exposure selector. The actual card prediction is in the queue DTO.
      return checked(PUBLIC_ROUTES.insights.response,{prediction:null,metrics:evaluation,audioFeatures:audio},'SERVICE_UNAVAILABLE');
    }));
    app.get(PUBLIC_ROUTES.analytics.path,security.safe(async request=>{
      const userId=await owner(request);
      const [evaluation,library]=await Promise.all([
        metrics(userId),
        data(LibrarySummarySchema,()=>options.getSummary(userId),'LIBRARY_SUMMARY_UNAVAILABLE'),
      ]);
      return checked(PUBLIC_ROUTES.analytics.response,{library,metrics:evaluation},'SERVICE_UNAVAILABLE');
    }));
  };
  return {registerRoutes};
}
