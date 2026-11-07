import {MusicaeQueue,type MusicaeEnvelope} from '../../../../../packages/db/src/musicae-queue';
import {MusicaeClient,MusicaeError,parseMusicaeBatch} from './musicae-provider';
import {ProviderError,retryDelay} from './provider';import {sleep} from '../../../../../packages/db/src/soundnet-queue';
export type MusicaeRunOptions={userId:string;maxRequests:number;maxWaitMs?:number;requirePro?:boolean};
export class MusicaeWorker {
 constructor(private queue:MusicaeQueue,private client:MusicaeClient,private options:{rightsBasis?:string;log?:(event:Record<string,unknown>)=>void}={}){}
 async run(options:MusicaeRunOptions,signal?:AbortSignal):Promise<{reason:string;requests:number;replayed:number}>{
  if(!Number.isInteger(options.maxRequests)||options.maxRequests<1||options.maxRequests>1000)throw Error('INVALID_REQUEST_BUDGET');
  const maxWait=options.maxWaitMs??60000;if(!Number.isFinite(maxWait)||maxWait<0||maxWait>3600000)throw Error('INVALID_WAIT_BUDGET');
  let requests=0,replayed=0,waited=0;const result=(reason:string)=>({reason,requests,replayed});
  while(!signal?.aborted){
   if(requests>=options.maxRequests)return result('REQUEST_BUDGET');
   const job=await this.queue.claim(options.requirePro!==false);if(!job)return result('COMPLETE');if(job.kind==='blocked')return result(job.reason);
   if(job.kind==='wait'){if(job.waitMs>maxWait-waited)return result('COOLDOWN');const pause=Math.min(1000,job.waitMs);try{await sleep(pause,signal);}catch{return result('ABORTED');}waited+=pause;continue;}
   let envelope:MusicaeEnvelope;
   if(job.kind==='replay'){envelope=job.envelope!;replayed++;}
   else{
    try{const response=await this.queue.dispatch(job,()=>{requests++;return this.client.fetch(job.tracks.map(t=>t.trackId),signal);},signal);if(!response)continue;envelope={response};}
    catch(error){if(!(error instanceof MusicaeError))throw error;envelope={response:error.evidence,error:{code:error.code,retryable:error.retryable,delayMs:retryDelay(job.attempt??1,error.retryAfterMs)}};}
    if(!await this.queue.storeResponse(job,envelope))return result('LEASE_LOST');
   }
   waited=0;
   if(envelope.error){const e=envelope.error;await this.queue.fail(job,e.code,e.retryable,e.delayMs);this.options.log?.({event:'musicae_request',requestId:job.id,tracks:job.tracks.length,httpStatus:envelope.response.httpStatus,latencyMs:envelope.response.latencyMs,code:e.code,remaining:envelope.response.remaining});if(['HTTP_401','HTTP_403','ABORTED'].includes(e.code))return result(e.code);continue;}
   try{
    const outcomes=parseMusicaeBatch(envelope.response.raw,job.tracks);if(!await this.queue.complete(job,outcomes,this.options.rightsBasis))return result('LEASE_LOST');
    this.options.log?.({event:'musicae_request',requestId:job.id,tracks:job.tracks.length,httpStatus:envelope.response.httpStatus,latencyMs:envelope.response.latencyMs,ready:outcomes.filter(r=>r.status==='success').length,quarantined:outcomes.filter(r=>r.status==='quarantined').length,unavailable:outcomes.filter(r=>r.status==='unavailable').length,failed:outcomes.filter(r=>r.status==='failed').length,remaining:envelope.response.remaining});
   }catch(error){if(!(error instanceof ProviderError))throw error;await this.queue.fail(job,error.code,false,0);this.options.log?.({event:'musicae_invalid_response',requestId:job.id,code:error.code});}
  }
  return result('ABORTED');
 }
}
