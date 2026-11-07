import {FeatureVectorSchema,TrackCardSchema,AudioFeatureStatusSchema,IdSchema,FEATURE_VERSION,type AudioFeatureStatus,type TrackCard} from '@sortfm/contracts';
import type {MusicaeResponse,MusicaeOutcome} from './musicae-types';
import {Database,json,type Transaction} from './client';
export type MusicaeEnvelope={response:MusicaeResponse;error?:{code:string;retryable:boolean;delayMs:number}};
export type MusicaeJob={kind:'request'|'replay';id:string;tracks:TrackCard[];attempt?:number;envelope?:MusicaeEnvelope};
export type MusicaeProgress={provider:'musicae';total:number;ready:number;musicaeReady:number;quarantined:number;unavailable:number;failed:number;pending:number;running:number;blockedReason:string|null;remaining:number|null;quotaLimit:number|null;requests:number;pausedUntil:string};
const leaseMs=180000;
async function live(tx:Transaction,id:string,state='responded'){const [row]=await tx`SELECT r.envelope,r.expected_tracks,r.responded_at FROM musicae_control c JOIN musicae_requests r ON r.request_id=c.active_request WHERE c.singleton AND c.active_request=${id} AND c.lease_until>clock_timestamp() AND r.state=${state} FOR UPDATE OF c,r`;return row;}
export class MusicaeQueue {
 constructor(readonly db:Database){}
 async enqueueUser(userId:string,priorityIds:string[]=[]):Promise<number>{IdSchema.parse(userId);if(priorityIds.length>10000||priorityIds.some(id=>!/^[A-Za-z0-9]{22}$/.test(id)))throw Error('INVALID_PRIORITY_IDS');const priority=Object.fromEntries(priorityIds.map((id,i)=>[id,i]));return this.db.transaction(async tx=>{
  const rows=await tx`INSERT INTO musicae_jobs(track_id,feature_version,priority_rank)
   SELECT s.track_id,${FEATURE_VERSION},COALESCE((${json(priority)}::jsonb->>s.track_id)::integer,1000+row_number() OVER(ORDER BY CASE WHEN s.current_status='saved' THEN 0 WHEN s.current_status='deferred' THEN 1 ELSE 2 END,s.original_added_at,s.track_id)::integer)
   FROM saved_tracks s JOIN tracks t USING(track_id) JOIN library_membership m USING(user_id,track_id)
   WHERE s.user_id=${userId} AND t.card->>'source'='spotify' AND t.card->>'isPlayable'='true' AND s.track_id ~ '^[A-Za-z0-9]{22}$'
    AND NOT EXISTS(SELECT 1 FROM available_audio_features a WHERE a.track_id=s.track_id AND a.feature_version=${FEATURE_VERSION})
   ON CONFLICT(track_id,feature_version) DO NOTHING RETURNING track_id`;
  // Reprioritizing never resets attempts or terminal states.
  await tx`UPDATE musicae_jobs j SET priority_rank=LEAST(priority_rank,(${json(priority)}::jsonb->>j.track_id)::integer) WHERE ${json(priority)}::jsonb ? j.track_id AND EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=${userId} AND m.track_id=j.track_id)`;
  return rows.length;
 });}
 async claim(requirePro=true):Promise<MusicaeJob|{kind:'wait';waitMs:number}|{kind:'blocked';reason:string}|null>{return this.db.transaction(async tx=>{
  const [c]=await tx`SELECT *,GREATEST(0,extract(epoch FROM (lease_until-clock_timestamp()))*1000)::float8 AS lease_ms FROM musicae_control WHERE singleton FOR UPDATE`;
  if(c.active_request){const [r]=await tx`SELECT * FROM musicae_requests WHERE request_id=${c.active_request} FOR UPDATE`;
   if(r.state==='responded'){await tx`UPDATE musicae_control SET lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond' WHERE singleton`;return {kind:'replay',id:r.request_id,tracks:r.expected_tracks.map((t:unknown)=>TrackCardSchema.parse(t)),envelope:r.envelope};}
   if(c.lease_ms>0)return {kind:'wait',waitMs:c.lease_ms};
   await tx`UPDATE musicae_requests SET state='indeterminate',finished_at=clock_timestamp() WHERE request_id=${c.active_request} AND state IN ('reserved','started')`;
   await tx`UPDATE musicae_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code='INTERRUPTED_REQUEST',request_id=NULL,updated_at=clock_timestamp() WHERE request_id=${c.active_request} AND status='running'`;
   await tx`UPDATE musicae_control SET active_request=NULL,lease_until=NULL WHERE singleton`;
  }
  if(c.blocked_reason)return {kind:'blocked',reason:c.blocked_reason};if(requirePro&&c.request_count>0&&(c.quota_limit??0)<1000)return {kind:'blocked',reason:'PRO_PLAN_NOT_VERIFIED'};
  if(c.remaining!==null&&c.remaining<=2){if(c.quota_reset_at&&new Date(c.quota_reset_at).getTime()>Date.now())return {kind:'wait',waitMs:new Date(c.quota_reset_at).getTime()-Date.now()};if(!c.quota_reset_at)return {kind:'blocked',reason:'QUOTA_RESERVE'};await tx`UPDATE musicae_control SET remaining=NULL,quota_reset_at=NULL WHERE singleton`;}
  const [wait]=await tx`SELECT GREATEST(0,extract(epoch FROM (GREATEST(next_start_at,paused_until)-clock_timestamp()))*1000)::float8 AS ms FROM musicae_control WHERE singleton`;if(wait.ms>0)return {kind:'wait',waitMs:wait.ms};
  await tx`UPDATE musicae_jobs j SET status='success',error_code=NULL,updated_at=clock_timestamp() WHERE status='pending' AND EXISTS(SELECT 1 FROM available_audio_features a WHERE a.track_id=j.track_id AND a.feature_version=j.feature_version)`;
  const rows=await tx`SELECT j.track_id,j.attempts,t.card FROM musicae_jobs j JOIN tracks t USING(track_id) WHERE j.feature_version=${FEATURE_VERSION} AND j.status='pending' AND j.attempts<3 AND j.available_at<=clock_timestamp() ORDER BY j.priority_rank,j.available_at,j.track_id FOR UPDATE OF j SKIP LOCKED LIMIT 5`;
  if(!rows.length){const [next]=await tx`SELECT CASE WHEN min(available_at) IS NULL THEN NULL ELSE GREATEST(1,extract(epoch FROM (min(available_at)-clock_timestamp()))*1000)::float8 END AS ms FROM musicae_jobs WHERE status='pending' AND feature_version=${FEATURE_VERSION} AND attempts<3`;return next.ms?{kind:'wait',waitMs:next.ms}:null;}
  const id=crypto.randomUUID(),tracks=rows.map((r:any)=>TrackCardSchema.parse(r.card));
  await tx`INSERT INTO musicae_requests(request_id,expected_tracks,state) VALUES(${id},${json(tracks)}::jsonb,'reserved')`;
  await tx`UPDATE musicae_jobs SET status='running',attempts=attempts+1,request_id=${id},updated_at=clock_timestamp() WHERE track_id IN(SELECT value FROM jsonb_array_elements_text(${json(tracks.map((t:TrackCard)=>t.trackId))}::jsonb)) AND feature_version=${FEATURE_VERSION}`;
  await tx`UPDATE musicae_control SET active_request=${id},lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond' WHERE singleton`;
  return {kind:'request',id,tracks,attempt:Math.max(...rows.map((r:any)=>Number(r.attempts)))+1};
 });}
 /** Commit conservative quota accounting before any HTTP side effect. */
 async dispatch(job:MusicaeJob,start:()=>Promise<MusicaeResponse>,signal?:AbortSignal):Promise<MusicaeResponse|null>{
  const reserved=await this.db.transaction(async tx=>{
   if(!await live(tx,job.id,'reserved'))return false;signal?.throwIfAborted();
   const [c]=await tx`SELECT remaining FROM musicae_control WHERE singleton`;if(c.remaining!==null&&c.remaining<=2)return false;
   await tx`UPDATE musicae_requests SET state='started',started_at=clock_timestamp() WHERE request_id=${job.id}`;
   await tx`UPDATE musicae_control SET request_count=request_count+1,next_start_at=clock_timestamp()+interval '1 second',remaining=CASE WHEN remaining IS NULL THEN NULL ELSE GREATEST(0,remaining-1) END WHERE singleton`;
   return true;
  });
  if(!reserved)return null;
  // This second lock fences a process delayed between commit and launch. Only the
  // caller that transitioned reserved->started can enter; retries cannot launch twice.
  // A rollback here leaves the already committed accounting conservatively consumed.
  const permit=await this.db.transaction(async tx=>{const before=performance.now();if(!await live(tx,job.id,'started'))return null;
   const [c]=await tx`SELECT extract(epoch FROM (lease_until-clock_timestamp()))*1000 AS remaining FROM musicae_control WHERE singleton`;
   if(Number(c.remaining)-(performance.now()-before)<125000)return null;signal?.throwIfAborted();
   const response=start().then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
   return {response};
  });if(!permit)return null;const result=await permit.response;if(!result.ok)throw result.error;return result.value;
 }
 async storeResponse(job:MusicaeJob,envelope:MusicaeEnvelope):Promise<boolean>{return this.db.transaction(async tx=>{
  if(!await live(tx,job.id,'started'))return false;const r=envelope.response;
  await tx`UPDATE musicae_requests SET state='responded',envelope=${json(envelope)}::jsonb,responded_at=clock_timestamp() WHERE request_id=${job.id}`;
  await tx`UPDATE musicae_control SET next_start_at=GREATEST(next_start_at,clock_timestamp()+interval '1 second'),remaining=COALESCE(${r.remaining},remaining),quota_limit=COALESCE(${r.limit},quota_limit),quota_reset_at=CASE WHEN ${r.resetSeconds}::integer IS NULL THEN quota_reset_at ELSE clock_timestamp()+${r.resetSeconds??0}*interval '1 second' END,paused_until=GREATEST(paused_until,clock_timestamp()+${r.retryAfterMs}*interval '1 millisecond'),updated_at=clock_timestamp() WHERE singleton`;
  return true;
 });}
 async complete(job:MusicaeJob,outcomes:MusicaeOutcome[],rightsBasis?:string):Promise<boolean>{return this.db.transaction(async tx=>{
  const row=await live(tx,job.id);if(!row)return false;
  const expected=row.expected_tracks.map((t:TrackCard)=>t.trackId).sort();if(json(outcomes.map(t=>t.trackId).sort())!==json(expected))throw Error('BATCH_IDENTITY_CONFLICT');
  for(const result of outcomes){
   if(result.status==='success'||result.status==='quarantined'){
    const normalized=FeatureVectorSchema.parse({featureVersion:FEATURE_VERSION,values:result.values,provenance:'musicae',permittedForTraining:result.status==='success'&&Boolean(rightsBasis),...(rightsBasis?{rightsBasis}:{})});
    await tx`INSERT INTO musicae_features(track_id,feature_version,quality,raw,normalized,data_quality,request_id,fetched_at) VALUES(${result.trackId},${FEATURE_VERSION},${result.status},${json(result.raw)}::jsonb,${json(normalized)}::jsonb,${json({code:result.code,verifier:'musicae.id-duration-v1',measuredAccuracyVerified:false})}::jsonb,${job.id},${new Date(row.responded_at).toISOString()}) ON CONFLICT DO NOTHING`;
   }
   await tx`UPDATE musicae_jobs SET status=${result.status},error_code=${result.code},request_id=NULL,updated_at=clock_timestamp() WHERE track_id=${result.trackId} AND feature_version=${FEATURE_VERSION} AND request_id=${job.id}`;
  }
  const failed=outcomes.every(r=>r.status==='failed');
  await tx`UPDATE musicae_requests SET state='complete',finished_at=clock_timestamp() WHERE request_id=${job.id}`;
  await tx`UPDATE musicae_control SET active_request=NULL,lease_until=NULL,consecutive_failures=CASE WHEN ${failed} THEN consecutive_failures+1 ELSE 0 END,blocked_reason=CASE WHEN ${failed} AND consecutive_failures>=2 THEN 'PROVIDER_CIRCUIT_OPEN' ELSE blocked_reason END WHERE singleton`;return true;
 });}
 async fail(job:MusicaeJob,code:string,retryable:boolean,delayMs:number):Promise<boolean>{if(!/^[A-Z0-9_]+$/.test(code)||!Number.isFinite(delayMs)||delayMs<0)throw Error('INVALID_RETRY');const severe=/^(HTTP_5\d\d|HTTP_408|TIMEOUT|NETWORK|EMPTY_BODY|BODY_TOO_LARGE|INVALID_JSON|PROVIDER_ERROR_BODY|INVALID_BATCH_RESPONSE|UNREQUESTED_PROVIDER_ID|DUPLICATE_PROVIDER_ID)$/.test(code);return this.db.transaction(async tx=>{
  if(!await live(tx,job.id))return false;
  await tx`UPDATE musicae_jobs SET status=CASE WHEN ${retryable} AND attempts<3 THEN 'pending' ELSE 'failed' END,error_code=${code},available_at=clock_timestamp()+${delayMs}*interval '1 millisecond',request_id=NULL,updated_at=clock_timestamp() WHERE request_id=${job.id} AND status='running'`;
  await tx`UPDATE musicae_requests SET state='failed',finished_at=clock_timestamp() WHERE request_id=${job.id}`;
  await tx`UPDATE musicae_control SET active_request=NULL,lease_until=NULL,consecutive_failures=CASE WHEN ${severe} THEN consecutive_failures+1 ELSE 0 END,blocked_reason=CASE WHEN ${code} IN ('HTTP_401','HTTP_403') THEN 'PROVIDER_AUTHORIZATION' WHEN ${severe} AND consecutive_failures>=2 THEN 'PROVIDER_CIRCUIT_OPEN' ELSE blocked_reason END WHERE singleton`;return true;
 });}
 async progress(userId:string):Promise<MusicaeProgress>{IdSchema.parse(userId);return this.db.transaction(async tx=>{
  const [p]=await tx`SELECT count(*)::int AS total,count(a.track_id)::int AS ready,count(*) FILTER(WHERE mf.quality='success')::int AS musicae_ready,count(*) FILTER(WHERE j.status='quarantined' AND a.track_id IS NULL)::int AS quarantined,count(*) FILTER(WHERE j.status='unavailable' AND a.track_id IS NULL)::int AS unavailable,count(*) FILTER(WHERE j.status='failed' AND a.track_id IS NULL)::int AS failed,count(*) FILTER(WHERE j.status='pending' AND a.track_id IS NULL)::int AS pending,count(*) FILTER(WHERE j.status='running' AND a.track_id IS NULL)::int AS running FROM library_membership m JOIN tracks t USING(track_id) LEFT JOIN available_audio_features a ON a.track_id=m.track_id AND a.feature_version=${FEATURE_VERSION} LEFT JOIN musicae_features mf ON mf.track_id=m.track_id AND mf.feature_version=${FEATURE_VERSION} LEFT JOIN musicae_jobs j ON j.track_id=m.track_id AND j.feature_version=${FEATURE_VERSION} WHERE m.user_id=${userId} AND t.card->>'source'='spotify'`;
  const [c]=await tx`SELECT * FROM musicae_control WHERE singleton`;return {provider:'musicae',total:p.total,ready:p.ready,musicaeReady:p.musicae_ready,quarantined:p.quarantined,unavailable:p.unavailable,failed:p.failed,pending:p.pending,running:p.running,blockedReason:c.blocked_reason,remaining:c.remaining,quotaLimit:c.quota_limit,requests:c.request_count,pausedUntil:new Date(c.paused_until).toISOString()};
 });}
 async audioStatus(userId:string):Promise<AudioFeatureStatus>{
  const p=await this.progress(userId),keys=['energy','danceability','happiness','acousticness','instrumentalness','liveness','speechiness','tempo_bpm','loudness_db','key_sin','key_cos','mode_major','soundnet_popularity'];
  const rows=await this.db.transaction(tx=>tx`SELECT a.normalized FROM library_membership m JOIN tracks t USING(track_id) LEFT JOIN available_audio_features a ON a.track_id=m.track_id AND a.feature_version=${FEATURE_VERSION} WHERE m.user_id=${userId} AND t.card->>'source'='spotify'`);
  const missingness=Object.fromEntries(keys.map(key=>[key,rows.length?rows.filter((r:any)=>r.normalized?.values[key]==null).length/rows.length:0]));
  const terminal=p.failed+p.quarantined+p.unavailable;
  return AudioFeatureStatusSchema.parse({provider:'musicae',status:p.ready===p.total?'complete':p.running?'running':p.ready+terminal===p.total?'failed':'pending',featuresReady:p.ready,featuresTotal:p.total,failed:terminal,missingness,reason:p.blockedReason??(p.quarantined?`${p.quarantined} responses quarantined for data-quality review. Other library features remain available.`:null)});
 }

}
