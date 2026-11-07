export type Fetcher=(url:string,init?:RequestInit)=>Promise<Response>;
export class ProviderError extends Error {
 constructor(readonly code:string,readonly retryable:boolean,readonly retryAfterMs=0,readonly raw?:unknown){super(code);}
}
export function retryDelay(attempt:number,retryAfterMs=0,random:()=>number=Math.random){const cap=Math.min(60000,1000*2**Math.min(16,Math.max(0,attempt-1)));return Math.max(retryAfterMs,Math.round(cap*(0.5+0.5*random())));}
export function parseRetryAfter(value:string|null,now=Date.now()) {if(!value)return 0;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):0;}
export class SoundNetClient {
 readonly timeoutMs:number;private fetcher:Fetcher;
 constructor(private key:string,options:{fetch?:Fetcher;timeoutMs?:number}={}){if(!key)throw new Error('SOUNDNET_RAPIDAPI_KEY_REQUIRED');this.fetcher=options.fetch??fetch;this.timeoutMs=options.timeoutMs??90000;if(!Number.isFinite(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>120000)throw new Error('INVALID_TIMEOUT');}
 async fetch(trackId:string,signal?:AbortSignal):Promise<{raw:unknown;latencyMs:number;bytes:number}>{
  if(!/^[A-Za-z0-9]{22}$/.test(trackId))throw new ProviderError('INVALID_TRACK_ID',false);
  const started=performance.now();const timeout=AbortSignal.timeout(this.timeoutMs);const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
   const response=await this.fetcher(`https://track-analysis.p.rapidapi.com/pktx/spotify/${encodeURIComponent(trackId)}`,{headers:{'x-rapidapi-key':this.key,'x-rapidapi-host':'track-analysis.p.rapidapi.com'},signal:combined,redirect:'error'});
   if(!response.ok){await response.body?.cancel();throw new ProviderError(`HTTP_${response.status}`,response.status===408||response.status===429||response.status>=500,parseRetryAfter(response.headers.get('retry-after')));}
   const reader=response.body?.getReader();if(!reader)throw new ProviderError('EMPTY_BODY',false);const decoder=new TextDecoder();let text='',bytes=0;
   while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>1048576){await reader.cancel();throw new ProviderError('BODY_TOO_LARGE',false);}text+=decoder.decode(chunk.value,{stream:true});}
   text+=decoder.decode();let raw:unknown;try{raw=JSON.parse(text);}catch{throw new ProviderError('INVALID_JSON',false);}
   // Observed live: SoundNet sometimes reports a failed upstream fetch as HTTP 200.
   // Preserve the worker's bounded retries instead of misclassifying this as bad features.
   if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&(raw as Record<string,unknown>).error==='Failed to pull track data')throw new ProviderError('PROVIDER_TRACK_UNAVAILABLE',true,0,raw);
   return {raw,bytes,latencyMs:performance.now()-started};
  }catch(error){if(error instanceof ProviderError)throw error;if(signal?.aborted)throw new ProviderError('ABORTED',true);throw new ProviderError(timeout.aborted?'TIMEOUT':'NETWORK',true);}
 }
}
