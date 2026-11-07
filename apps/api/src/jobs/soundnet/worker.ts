import {SoundNetQueue,sleep,type ClaimedJob} from '../../../../../packages/db/src/soundnet-queue';
import {SoundNetClient,ProviderError,retryDelay} from './provider';
import {normalizeSoundNet} from './normalize';
export type WorkerOptions={concurrency?:number;maxConcurrency?:number;random?:()=>number;rightsBasis?:string;log?:(event:Record<string,unknown>)=>void};
export class SoundNetWorker {
 concurrency:number;private successes=0;private maxConcurrency:number;private log:(event:Record<string,unknown>)=>void;
 constructor(readonly queue:SoundNetQueue,readonly client:SoundNetClient,private options:WorkerOptions={}){
  this.concurrency=options.concurrency??3;this.maxConcurrency=options.maxConcurrency??5;this.log=options.log??(()=>{});
  if(!Number.isInteger(this.concurrency)||!Number.isInteger(this.maxConcurrency)||this.concurrency<1||this.maxConcurrency<this.concurrency||this.maxConcurrency>200)throw new Error('INVALID_CONCURRENCY');
 }
 async process(job:ClaimedJob,signal?:AbortSignal){
  const lease=new AbortController();const combined=signal?AbortSignal.any([signal,lease.signal]):lease.signal;
  let renewing=false;
  const heartbeat=setInterval(async()=>{if(renewing)return;renewing=true;try{if(!await this.queue.renew(job))lease.abort();}catch{lease.abort();}finally{renewing=false;}},30000);
  try{
   let response:Awaited<ReturnType<SoundNetClient['fetch']>>|undefined;let normalized:ReturnType<typeof normalizeSoundNet>;
   try{
    response=await this.queue.dispatch(()=>this.client.fetch(job.trackId,combined),combined);
    try{normalized=normalizeSoundNet(response.raw,job.trackId,{permittedForTraining:Boolean(this.options.rightsBasis),...(this.options.rightsBasis?{rightsBasis:this.options.rightsBasis}:{})});}catch{throw new ProviderError('INVALID_FEATURES',false);}
   }catch(error){
    if(combined.aborted)return; // Keep the lease for another worker to recover; no false success.
    if(!(error instanceof ProviderError))throw error; // Database failure must terminate, not masquerade as a provider retry.
    const delay=retryDelay(job.attempts,error.retryAfterMs,this.options.random);
    if(error.code==='HTTP_429'){await this.queue.cooldown(delay);this.concurrency=Math.max(1,Math.floor(this.concurrency/2));this.successes=0;}
    else if(error.retryable){this.concurrency=Math.max(1,this.concurrency-1);this.successes=0;}
    await this.queue.fail(job,error.code,error.retryable,delay,response?.raw);
    if(error.code==='HTTP_401'||error.code==='HTTP_403'){await this.queue.cooldown(3600000);throw error;}
    this.log({trackId:job.trackId,status:'failed',code:error.code,attempt:job.attempts,retryInMs:error.retryable&&job.attempts<this.queue.maxAttempts?delay:null,concurrency:this.concurrency});return;
   }
   const committed=await this.queue.complete(job,normalized);
   if(committed&&++this.successes>=20){this.concurrency=Math.min(this.maxConcurrency,this.concurrency+1);this.successes=0;}
   this.log({trackId:job.trackId,status:committed?'success':'lease_lost',attempt:job.attempts,latencyMs:Math.round(response.latencyMs),bytes:response.bytes,concurrency:this.concurrency});
  }finally{clearInterval(heartbeat);}
 }
 async run(signal?:AbortSignal){
  const stopping=new AbortController();const combined=signal?AbortSignal.any([signal,stopping.signal]):stopping.signal;const running=new Set<Promise<void>>();
  try{
   while(!combined.aborted){
    let empty=false;
    while(running.size<this.concurrency&&!combined.aborted){const job=await this.queue.claim();if(!job){empty=true;break;}const task=this.process(job,combined);running.add(task);task.then(()=>running.delete(task),()=>{});}
    if(running.size){await Promise.race(running);continue;}
    if(empty&&await this.queue.unfinished()===0)return;
    await sleep(500,combined);
   }
  }catch(error){if(!signal?.aborted)throw error;}finally{stopping.abort();await Promise.allSettled(running);}
 }
}
