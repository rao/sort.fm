/** Explicit owner request to fit the same authoritative snapshot used by the worker. */
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {FitResponseSchema,PUBLIC_ROUTES} from '@sortfm/contracts';
import {reviewRouteSecurity,type ReviewRouteOptions} from '../reviews/module';
import {SpotifyError} from '../spotify/errors';
import {MlClientError} from './client';
import type {RepositoryMl} from './repository';

export interface MlRetrainOptions extends ReviewRouteOptions {
  /** Inject the same repository-backed adapter/configuration as automatic feedback. */
  ml:Pick<RepositoryMl,'fit'>|null;
  /** Total handler wait budget; cannot extend an inner HTTP/database deadline. */
  timeoutMs?:number;
}

function ambiguousTimeout():SpotifyError {
  return new SpotifyError('ML_RETRAIN_TIMEOUT',
    'Training timed out and may still complete. Refresh model insights before explicitly requesting another fit.',504,false);
}
function invalidResponse():SpotifyError {
  return new SpotifyError('ML_INVALID_RESPONSE',
    'The training result could not be verified. Refresh model insights before explicitly requesting another fit.',502,false);
}

export function createMlRetrainModule(options:MlRetrainOptions) {
  const security=reviewRouteSecurity(options),empty=z.strictObject({});
  const timeoutMs=options.timeoutMs??45000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2_147_483_647)
    throw new RangeError('timeoutMs must be a positive timer-safe integer.');

  async function bounded<T>(read:()=>Promise<T>,deadline:number,error:SpotifyError):Promise<T> {
    const remaining=deadline-performance.now();
    if(remaining<=0)throw error;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(error),Math.ceil(remaining));}),
      ]);
    } finally {clearTimeout(timer);}
  }

  const registerRoutes=async(app:FastifyInstance)=>{
    app.post(PUBLIC_ROUTES.retrain.path,security.safe(async request=>{
      const deadline=performance.now()+timeoutMs;
      security.csrf(request);empty.parse(request.query);
      if(request.body!==undefined)empty.parse(request.body);
      // Bound auth separately so a late session resolution cannot start an abandoned fit.
      const userId=await bounded(()=>security.owner(request),deadline,new SpotifyError('AUTHENTICATION_UNAVAILABLE',
        'Session validation timed out. No training request was started.',503,true));
      if(!options.ml)throw new SpotifyError('ML_UNAVAILABLE','The ML service is not configured for training.',503,false);
      let result:unknown;
      const timeout=ambiguousTimeout();
      try {
        // RepositoryMl reads the revision and exposure-time examples atomically. Never retry here.
        result=await bounded(()=>options.ml!.fit(userId),deadline,timeout);
      } catch(error) {
        if(error===timeout||(error instanceof MlClientError&&error.code==='ML_TIMEOUT'))throw timeout;
        if(error instanceof MlClientError&&error.code==='ML_INVALID_RESPONSE')throw invalidResponse();
        if(error instanceof MlClientError&&error.code==='STALE_REVISION')
          throw new SpotifyError('STALE_REVISION',
            'The feedback snapshot was superseded or conflicts with a completed fit. Refresh model insights before explicitly retrying.',409,false);
        throw new SpotifyError('ML_UNAVAILABLE',
          'The training request could not be confirmed and may have completed. Refresh model insights before explicitly requesting another fit.',503,false);
      }
      const parsed=FitResponseSchema.safeParse(result);
      if(!parsed.success||parsed.data.userId!==userId
        ||parsed.data.modelVersion!==parsed.data.metrics.modelVersion
        ||parsed.data.trainedExamples!==parsed.data.metrics.trainedExamples)throw invalidResponse();
      return parsed.data;
    }));
  };
  return {registerRoutes};
}
