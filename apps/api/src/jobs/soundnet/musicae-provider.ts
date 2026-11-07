import {FeatureValuesSchema,type TrackCard} from '@sortfm/contracts';
import {ProviderError,parseRetryAfter,type Fetcher} from './provider';
import type {MusicaeOutcome,MusicaeResponse} from '../../../../../packages/db/src/musicae-types';
export type {MusicaeOutcome,MusicaeResponse} from '../../../../../packages/db/src/musicae-types';
export class MusicaeError extends ProviderError {constructor(code:string,retryable:boolean,readonly evidence:MusicaeResponse){super(code,retryable,evidence.retryAfterMs,evidence.raw);}}
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);if(signal.aborted){reject(signal.reason);return;}signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
export class MusicaeClient {
 readonly timeoutMs:number;private fetcher:Fetcher;
 constructor(private key:string,options:{fetch?:Fetcher;timeoutMs?:number}={}){if(!key||/[\r\n]/.test(key))throw new Error('MUSICAE_RAPIDAPI_KEY_REQUIRED');this.fetcher=options.fetch??fetch;this.timeoutMs=options.timeoutMs??30000;if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>120000)throw new Error('INVALID_TIMEOUT');}
 async fetch(ids:string[],signal?:AbortSignal):Promise<MusicaeResponse>{
  if(!ids.length||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>!/^[A-Za-z0-9]{22}$/.test(id)))throw new ProviderError('INVALID_BATCH',false);
  const started=performance.now(),timeout=AbortSignal.timeout(this.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  const evidence:MusicaeResponse={raw:null,httpStatus:0,latencyMs:0,remaining:null,limit:null,resetSeconds:null,retryAfterMs:0,bytes:0};let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   combined.throwIfAborted();const response=await abortable(this.fetcher(`https://spotify-extended-audio-features-api.p.rapidapi.com/v1/audio-features?${new URLSearchParams({ids:ids.join(',')})}`,{headers:{'x-rapidapi-key':this.key,'x-rapidapi-host':'spotify-extended-audio-features-api.p.rapidapi.com'},signal:combined,redirect:'error'}),combined);
   evidence.httpStatus=response.status;for(const [field,header] of [['remaining','x-ratelimit-requests-remaining'],['limit','x-ratelimit-requests-limit'],['resetSeconds','x-ratelimit-requests-reset']] as const){const value=response.headers.get(header);evidence[field]=value!==null&&/^\d+$/.test(value)?Number(value)<=2147483647?Number(value):null:null;}
   evidence.retryAfterMs=parseRetryAfter(response.headers.get('retry-after'));reader=response.body?.getReader();if(!reader)throw new MusicaeError('EMPTY_BODY',false,evidence);
   const decoder=new TextDecoder();let text='';while(true){const part=await abortable(reader.read(),combined);if(part.done)break;evidence.bytes+=part.value.byteLength;if(evidence.bytes>1048576)throw new MusicaeError('BODY_TOO_LARGE',false,evidence);text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();text=text.replaceAll(this.key,'[redacted]');
   try{evidence.raw=JSON.parse(text);}catch{evidence.raw=text.slice(0,2000);if(response.ok)throw new MusicaeError('INVALID_JSON',false,evidence);}
   if(!response.ok)throw new MusicaeError(`HTTP_${response.status}`,response.status===408||response.status===429||response.status>=500,evidence);
   if(evidence.raw&&typeof evidence.raw==='object'&&('error' in evidence.raw||('success' in evidence.raw&&evidence.raw.success===false)))throw new MusicaeError('PROVIDER_ERROR_BODY',false,evidence);
   evidence.latencyMs=performance.now()-started;return evidence;
  }catch(error){evidence.latencyMs=performance.now()-started;if(evidence.httpStatus>=400&&!signal?.aborted)throw new MusicaeError(`HTTP_${evidence.httpStatus}`,evidence.httpStatus===408||evidence.httpStatus===429||evidence.httpStatus>=500,evidence);if(error instanceof MusicaeError)throw error;throw new MusicaeError(signal?.aborted?'ABORTED':timeout.aborted?'TIMEOUT':'NETWORK',true,evidence);
  }finally{void reader?.cancel().catch(()=>{});}
 }
}
const units=['energy','danceability','acousticness','instrumentalness','liveness','speechiness','valence'] as const;
/** Validate IDs before normalizing. No positional joins or SoundNet percentage conversion. */
export function parseMusicaeBatch(raw:unknown,tracks:TrackCard[]):MusicaeOutcome[]{
 if(!raw||typeof raw!=='object'||!('audio_features' in raw)||!Array.isArray(raw.audio_features))throw new ProviderError('INVALID_BATCH_RESPONSE',false);
 const expected=new Set(tracks.map(t=>t.trackId)),byId=new Map<string,Record<string,unknown>>();
 for(const row of raw.audio_features){if(row===null)continue;if(!row||typeof row!=='object'||typeof row.id!=='string')throw new ProviderError('INVALID_BATCH_RESPONSE',false);if(!expected.has(row.id))throw new ProviderError('UNREQUESTED_PROVIDER_ID',false);if(byId.has(row.id))throw new ProviderError('DUPLICATE_PROVIDER_ID',false);byId.set(row.id,row);}
 return tracks.map(track=>{
  const row=byId.get(track.trackId),result:MusicaeOutcome={trackId:track.trackId,status:'success',code:null,raw:row??null};
  const bad=(code:string,status:MusicaeOutcome['status']='failed')=>({...result,status,code});
  if(!row)return bad('TRACK_UNAVAILABLE','unavailable');
  if(row.uri!==`spotify:track:${track.trackId}`||row.type!=='audio_features')return bad('IDENTITY_MISMATCH');
  if(typeof row.duration_ms!=='number'||!Number.isInteger(row.duration_ms)||row.duration_ms<=0||Math.abs(row.duration_ms-track.durationMs)>Math.max(2000,track.durationMs*0.01))return bad('DURATION_MISMATCH');
  for(const k of units){const value=row[k];if(value!=null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1))return bad('INVALID_FEATURES');}
  const key=row.key;if(key!=null&&(typeof key!=='number'||!Number.isInteger(key)||key< -1||key>11))return bad('INVALID_FEATURES');
  const mode=row.mode;if(mode!=null&&mode!==0&&mode!==1)return bad('INVALID_FEATURES');
  const values={happiness:null,soundnet_popularity:null,energy:row.energy??null,danceability:row.danceability??null,acousticness:row.acousticness??null,instrumentalness:row.instrumentalness??null,liveness:row.liveness??null,speechiness:row.speechiness??null,tempo_bpm:row.tempo??null,loudness_db:row.loudness??null,key_sin:key==null||key===-1?null:Math.sin(2*Math.PI*Number(key)/12),key_cos:key==null||key===-1?null:Math.cos(2*Math.PI*Number(key)/12),mode_major:mode??null};
  const parsed=FeatureValuesSchema.safeParse(values);if(!parsed.success)return bad('INVALID_FEATURES');result.values=parsed.data;
  const observed=units.filter(k=>k!=='valence'&&row[k]!=null);
  if(observed.length<4)return {...result,status:'quarantined',code:'INSUFFICIENT_FEATURES'};
  if(observed.every(k=>typeof row[k]==='number'&&Math.abs(Number(row[k])*100-Math.round(Number(row[k])*100))<1e-8)&&row.duration_ms%1000===0)return {...result,status:'quarantined',code:'COARSE_FEATURE_ESTIMATE'};
  return result;
 });
}
