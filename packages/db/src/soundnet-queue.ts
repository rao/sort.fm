import {TrackCardSchema,type TrackCard,AudioFeaturesInputSchema,AudioFeatureStatusSchema,FEATURE_VERSION,type AudioFeaturesInput,type AudioFeatureStatus} from '@sortfm/contracts';
import {Database,json} from './client';
export type ClaimedJob={trackId:string;featureVersion:typeof FEATURE_VERSION;token:string;attempts:number};
export class SoundNetQueue {
 constructor(readonly db:Database,readonly maxAttempts=5){}
 async enqueueUser(userId:string){return this.db.transaction(async tx=>{
  const rows=await tx`INSERT INTO soundnet_jobs(track_id,feature_version) SELECT s.track_id,${FEATURE_VERSION} FROM saved_tracks s JOIN tracks t USING(track_id) WHERE s.user_id=${userId} AND s.track_id ~ '^[a-zA-Z0-9]{22}$' AND t.card->>'source'='spotify' AND (NOT EXISTS(SELECT 1 FROM library_state WHERE user_id=${userId}) OR EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id)) AND NOT EXISTS(SELECT 1 FROM audio_features a WHERE a.track_id=s.track_id AND a.feature_version=${FEATURE_VERSION}) ON CONFLICT DO NOTHING RETURNING track_id`;return rows.length;
 });}
 async claim(leaseMs=180000):Promise<ClaimedJob|null>{return this.db.transaction(async tx=>{
  // Smoke/cache writes may win while a worker is running. Reconcile after that lease expires.
  await tx`UPDATE soundnet_jobs j SET status='success',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE j.status!='success' AND (j.status!='running' OR j.lease_until<=now()) AND EXISTS(SELECT 1 FROM audio_features a WHERE a.track_id=j.track_id AND a.feature_version=j.feature_version)`;
  await tx`UPDATE soundnet_jobs SET status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE attempts>=${this.maxAttempts} AND (status='pending' OR (status='running' AND lease_until<=now()))`;
  const [row]=await tx`SELECT track_id,feature_version FROM soundnet_jobs j WHERE feature_version=${FEATURE_VERSION} AND attempts<${this.maxAttempts} AND ((status='pending' AND available_at<=now()) OR (status='running' AND lease_until<=now())) AND NOT EXISTS(SELECT 1 FROM audio_features a WHERE a.track_id=j.track_id AND a.feature_version=j.feature_version) ORDER BY available_at,track_id FOR UPDATE SKIP LOCKED LIMIT 1`;
  if(!row)return null;const token=crypto.randomUUID();
  const [job]=await tx`UPDATE soundnet_jobs SET status='running',attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond',updated_at=now() WHERE track_id=${row.track_id} AND feature_version=${row.feature_version} RETURNING attempts`;
  return {trackId:row.track_id,featureVersion:FEATURE_VERSION,token,attempts:job.attempts};
 });}
 async trackMetadata(trackId:string):Promise<TrackCard|null>{return this.db.transaction(async tx=>{const [row]=await tx`SELECT card FROM tracks WHERE track_id=${trackId}`;return row?TrackCardSchema.parse(row.card):null;});}
 /** Start evidence only once for the live lease. A crash leaves a visible started row;
  * a recovered lease gets its own row and consumes another existing attempt. */
 async beginAttempt(job:ClaimedJob,endpoint:'spotify_id'|'title_artist'):Promise<TrackCard|null>{return this.db.transaction(async tx=>{
  const [live]=await tx`SELECT track_id FROM soundnet_jobs WHERE track_id=${job.trackId} AND feature_version=${job.featureVersion} AND lease_token=${job.token} AND attempts=${job.attempts} AND status='running' AND lease_until>clock_timestamp() FOR UPDATE`;
  if(!live)return null;
  const [row]=await tx`SELECT card FROM tracks WHERE track_id=${job.trackId}`;const track=TrackCardSchema.parse(row.card);
  const rows=await tx`INSERT INTO soundnet_attempts(lease_token,track_id,feature_version,attempt,endpoint,expected_track) VALUES(${job.token},${job.trackId},${job.featureVersion},${job.attempts},${endpoint},${json(track)}::jsonb) ON CONFLICT DO NOTHING RETURNING lease_token`;
  return rows.length?track:null;
 });}
 async renew(job:ClaimedJob,leaseMs=180000):Promise<boolean>{return this.db.transaction(async tx=>(await tx`UPDATE soundnet_jobs SET lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond' WHERE track_id=${job.trackId} AND feature_version=${job.featureVersion} AND lease_token=${job.token} AND status='running' AND lease_until>clock_timestamp() RETURNING track_id`).length>0);}
 async complete(job:ClaimedJob,input:AudioFeaturesInput):Promise<boolean>{const v=AudioFeaturesInputSchema.parse(input);if(v.status!=='success'||v.trackId!==job.trackId||v.normalized.featureVersion!==job.featureVersion)throw new Error('CACHE_IDENTITY_CONFLICT');return this.db.transaction(async tx=>{
  const rows=await tx`UPDATE soundnet_jobs SET status='success',lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE track_id=${job.trackId} AND feature_version=${job.featureVersion} AND lease_token=${job.token} AND status='running' AND lease_until>clock_timestamp() RETURNING track_id`;
  if(!rows.length)return false;
  await tx`UPDATE soundnet_attempts SET outcome='success',raw=${json(v.raw)}::jsonb,finished_at=clock_timestamp() WHERE lease_token=${job.token}`;
  await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${v.trackId},${job.featureVersion},${v.provider},${json(v.raw)}::jsonb,${json(v.normalized)}::jsonb,${json(v.dataQuality)}::jsonb,${v.fetchedAt}) ON CONFLICT DO NOTHING`;return true;
 });}
 async fail(job:ClaimedJob,code:string,retryable:boolean,delayMs:number,raw?:unknown):Promise<boolean>{
  if(!/^[A-Z0-9_]+$/.test(code)||!Number.isFinite(delayMs)||delayMs<0)throw new Error('INVALID_RETRY');
  return this.db.transaction(async tx=>{
   const rows=await tx`UPDATE soundnet_jobs SET status=${retryable&&job.attempts<this.maxAttempts?'pending':'failed'},available_at=clock_timestamp()+${delayMs}*interval '1 millisecond',error_code=${code},lease_token=NULL,lease_until=NULL,updated_at=now() WHERE track_id=${job.trackId} AND feature_version=${job.featureVersion} AND lease_token=${job.token} AND status='running' AND lease_until>clock_timestamp() RETURNING track_id`;
   if(rows.length)await tx`UPDATE soundnet_attempts SET outcome=${code},raw=${raw===undefined?null:json(raw)}::jsonb,finished_at=clock_timestamp() WHERE lease_token=${job.token}`;
   if(rows.length && raw!==undefined)await tx`INSERT INTO soundnet_failures(track_id,feature_version,attempt,lease_token,error_code,raw) VALUES(${job.trackId},${job.featureVersion},${job.attempts},${job.token},${code},${json(raw)}::jsonb) ON CONFLICT DO NOTHING`;
   return rows.length>0;
  });
 }
 async retryFailed(){return this.db.transaction(async tx=>(await tx`UPDATE soundnet_jobs SET status='pending',attempts=0,error_code=NULL,available_at=now() WHERE status='failed' AND feature_version=${FEATURE_VERSION} RETURNING track_id`).length);}
 async unfinished(){return this.db.transaction(async tx=>Number((await tx`SELECT count(*) AS n FROM soundnet_jobs WHERE feature_version=${FEATURE_VERSION} AND status IN('pending','running')`)[0].n));}
 async cooldown(delayMs:number){if(!Number.isFinite(delayMs)||delayMs<0)throw new Error('INVALID_COOLDOWN');await this.db.transaction(async tx=>{await tx`UPDATE provider_limits SET paused_until=GREATEST(paused_until,clock_timestamp()+${delayMs}*interval '1 millisecond') WHERE provider='soundnet'`;});}
 /** Reserve a durable 30s crash hold before starting a request. The second transaction
  * holds the limiter row through the actual start, then sets a 250ms spacing deadline.
  * Commit shortens the hold; rollback retains it. Conservative elapsed-time subtraction
  * leaves at least 250ms of the old hold after start even if the second transaction fails.
  * This tolerates DB round trips above 250ms without repeatedly expiring unused permits. */
 async dispatch<T>(start:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  while(true){signal?.throwIfAborted();
   const reservation=await this.db.transaction(async tx=>{
    const [limit]=await tx`SELECT GREATEST(0,extract(epoch FROM (GREATEST(next_start_at,paused_until)-clock_timestamp()))*1000)::float8 AS wait_ms FROM provider_limits WHERE provider='soundnet' FOR UPDATE`;
    if(limit.wait_ms>0)return {wait:limit.wait_ms};const token=crypto.randomUUID();
    await tx`UPDATE provider_limits SET next_start_at=clock_timestamp()+interval '30 seconds',permit_token=${token} WHERE provider='soundnet'`;return {token};
   });
   if(!reservation.token){await sleep(Math.min(reservation.wait??250,250),signal);continue;}
   const permit=await this.db.transaction(async tx=>{
    const checkedAt=performance.now();
    const [row]=await tx`SELECT permit_token,extract(epoch FROM (next_start_at-clock_timestamp()))*1000 AS remaining_ms,paused_until<=clock_timestamp() AS valid FROM provider_limits WHERE provider='soundnet' FOR UPDATE`;
    signal?.throwIfAborted();
    // Subtract the entire round trip, including time before the server measurement,
    // so clock skew and a delayed SQL response cannot grant a nearly expired hold.
    if(!row.valid||row.permit_token!==reservation.token||Number(row.remaining_ms)-(performance.now()-checkedAt)<=250)return null;
    // Rejection is handled immediately while COMMIT is pending; network response is awaited outside the transaction.
    const response=start().then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
    // Measure spacing AFTER the request starts. Slow DB responses can only reduce throughput.
    await tx`UPDATE provider_limits SET next_start_at=clock_timestamp()+interval '250 milliseconds',permit_token=NULL WHERE provider='soundnet'`;
    return {response};
   });
   if(!permit)continue;const result=await permit.response;if(!result.ok)throw result.error;return result.value;
  }
 }
 async progress(userId:string):Promise<AudioFeatureStatus>{return this.db.transaction(async tx=>{
  const rows=await tx`SELECT a.normalized,j.status FROM saved_tracks s JOIN tracks t USING(track_id) LEFT JOIN audio_features a ON a.track_id=s.track_id AND a.feature_version=${FEATURE_VERSION} LEFT JOIN soundnet_jobs j ON j.track_id=s.track_id AND j.feature_version=${FEATURE_VERSION} WHERE s.user_id=${userId} AND t.card->>'source'='spotify' AND (NOT EXISTS(SELECT 1 FROM library_state WHERE user_id=${userId}) OR EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id))`;
  const ready=rows.filter((r:any)=>r.normalized);const failed=rows.filter((r:any)=>!r.normalized&&r.status==='failed').length;
  const missingness:Record<string,number>={};const keys=['energy','danceability','happiness','acousticness','instrumentalness','liveness','speechiness','tempo_bpm','loudness_db','key_sin','key_cos','mode_major','soundnet_popularity'];
  for(const key of keys)missingness[key]=rows.length?rows.filter((r:any)=>r.normalized?.values[key]==null).length/rows.length:0;
  const [acceptance]=await tx`SELECT EXISTS(SELECT 1 FROM provider_smoke WHERE provider='soundnet' AND verified_at>clock_timestamp()-interval '7 days') AS approved,(SELECT report FROM provider_smoke WHERE provider='soundnet-review') AS review`;
  const failedSmoke=Array.isArray(acceptance.review?.samples)&&acceptance.review.samples.some((s:any)=>s.status==='failed');
  const reason=rows.length>ready.length&&!acceptance.approved
   ?failedSmoke?'SoundNet verification failed; bulk ingestion is paused. Library metadata and cached audio features remain available.':'Awaiting five-track SoundNet verification. Library metadata remains available.'
   :null;
  return AudioFeatureStatusSchema.parse({provider:'soundnet',status:rows.length===ready.length?'complete':rows.some((r:any)=>r.status==='running')?'running':ready.length+failed===rows.length?'failed':'pending',featuresReady:ready.length,featuresTotal:rows.length,failed,missingness,reason});
 });}
 async approveSmoke(report:unknown){await this.db.transaction(async tx=>{await tx`INSERT INTO provider_smoke(provider,verified_at,report) VALUES('soundnet',now(),${json(report)}::jsonb) ON CONFLICT(provider) DO UPDATE SET verified_at=excluded.verified_at,report=excluded.report`;});}
 async smokeApproved(mode:'spotify_id'|'title_artist'='spotify_id',verifier?:string){return this.db.transaction(async tx=>{
  const [row]=await tx`SELECT report FROM provider_smoke WHERE provider='soundnet' AND verified_at>now()-interval '7 days'`;
  if(!row)return false;if(mode==='spotify_id')return (row.report.lookupMode??'spotify_id')==='spotify_id';
  return row.report.lookupMode===mode&&Boolean(verifier)&&row.report.verifier===verifier&&row.report.version==='soundnet.title-acceptance.v1'&&row.report.operatorReviewed===true&&typeof row.report.id==='string';
 });}
}
export function sleep(ms:number,signal?:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{
 if(signal?.aborted){reject(signal.reason);return;}const abort=()=>{clearTimeout(timer);reject(signal?.reason);};
 const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});
});}
