import {PlaybackError} from './errors';
export interface PlaybackTransportOptions {fetch?:(url:string,init?:RequestInit)=>Promise<Response>;now?:()=>number;timeoutMs?:number}
/** Fixed-origin, one-attempt transport. Never follows redirects or retries credentials/commands. */
export class PlaybackTransport {
 readonly now:()=>number;private readonly fetcher:NonNullable<PlaybackTransportOptions['fetch']>;private readonly timeoutMs:number;
 constructor(options:PlaybackTransportOptions={}){this.now=options.now??Date.now;this.fetcher=options.fetch??fetch;this.timeoutMs=options.timeoutMs??15000;if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<=0||this.timeoutMs>20000)throw Error('Invalid playback timeout');}
 token(body:URLSearchParams){return this.request('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body},false,true);}
 api(path:string,token:string,input:{method?:'GET'|'PUT';body?:unknown}={}){
  if(!path.startsWith('/me')||path.includes('#')||path.includes('\\'))throw new PlaybackError('PLAYBACK_UNAVAILABLE');
  return this.request(`https://api.spotify.com/v1${path}`,{method:input.method??'GET',headers:{Authorization:`Bearer ${token}`,...(input.body===undefined?{}:{'Content-Type':'application/json'})},...(input.body===undefined?{}:{body:JSON.stringify(input.body)})},input.method==='PUT',false);
 }
 private async request(url:string,init:RequestInit,write:boolean,token:boolean):Promise<unknown>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,response:Response|undefined;
  let text:string;
  try{
   text=await Promise.race([(async()=>{response=await this.fetcher(url,{...init,redirect:'error',signal:controller.signal});
    if(Number(response.headers.get('content-length'))>1_000_000)throw Error('oversized');
    const body=await response.text();if(body.length>1_000_000)throw Error('oversized');return body;})(),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('deadline'));},this.timeoutMs);})]);
  }catch{controller.abort();throw new PlaybackError(write||token?'PLAYBACK_OUTCOME_UNKNOWN':'PLAYBACK_UNAVAILABLE');}
  finally{clearTimeout(timer);}
  let body:unknown=null;
  if(text)try{body=JSON.parse(text);}catch{if(response!.ok)throw new PlaybackError(write||token?'PLAYBACK_OUTCOME_UNKNOWN':'PLAYBACK_UNAVAILABLE');}
  if(response!.ok)return body;
  const status=response!.status;
  if(status===429){const raw=response!.headers.get('retry-after')??'',seconds=/^\d+(\.\d+)?$/.test(raw)?Number(raw)*1000:NaN,date=Date.parse(raw)-this.now();
   const delay=Number.isFinite(seconds)?seconds:Number.isFinite(date)?date:30000;throw new PlaybackError('PLAYBACK_RATE_LIMITED',this.now()+Math.max(1000,Math.min(delay,86400000)));}
  if(token){if(status===400&&body&&typeof body==='object'&&'error'in body&&body.error==='invalid_grant')throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');throw new PlaybackError(status>=500?'PLAYBACK_OUTCOME_UNKNOWN':'PLAYBACK_UNAVAILABLE');}
  if(status===401)throw new PlaybackError('PLAYBACK_RECONNECT_REQUIRED');
  if(status===404)throw new PlaybackError('PLAYBACK_DEVICE_UNAVAILABLE');
  if(status===403){const reason=body&&typeof body==='object'&&'error'in body&&body.error&&typeof body.error==='object'&&'reason'in body.error?body.error.reason:null;
   throw new PlaybackError(reason==='PREMIUM_REQUIRED'?'PLAYBACK_PREMIUM_REQUIRED':reason==='RESTRICTION_VIOLATED'?'PLAYBACK_DEVICE_RESTRICTED':'PLAYBACK_SCOPE_REJECTED');}
  throw new PlaybackError(write?'PLAYBACK_OUTCOME_UNKNOWN':'PLAYBACK_UNAVAILABLE');
 }
}
