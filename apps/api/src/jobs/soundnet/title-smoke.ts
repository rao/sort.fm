import {FEATURE_VERSION,TrackCardSchema} from '@sortfm/contracts';
import {type Database,json} from '../../../../../packages/db/src/client';
import {SoundNetQueue} from '../../../../../packages/db/src/soundnet-queue';
import {SoundNetClient,ProviderError} from './provider';
import {normalizeVerifiedTitle,titleLookup,titleFingerprint,TITLE_VERIFIER} from './identity';
import {TITLE_ACCEPTANCE,validateTitleAcceptance} from './acceptance';
export async function titleSmoke(db:Database,queue:SoundNetQueue,client:SoundNetClient,signal?:AbortSignal,log:(event:Record<string,unknown>)=>void=console.log){
 const [row]=await db.transaction(tx=>tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review'`);
 const originals=row?.report?.samples;
 if(!Array.isArray(originals)||originals.length!==5||new Set(originals.map(s=>s.trackId)).size!==5)throw new Error('ORIGINAL_FIVE_SMOKE_TRACKS_REQUIRED');
 // Detect actual collisions among these five candidates; do not infer a global catalog.
 const fingerprints=new Map<string,number>();
 for(const original of originals){const track=await queue.trackMetadata(original.trackId);try{if(track){const key=titleFingerprint(track);fingerprints.set(key,(fingerprints.get(key)??0)+1);}}catch{/* Unsupported metadata is retained as a failed sample below. */}}
 const id=crypto.randomUUID(),createdAt=new Date().toISOString();
 const attempt={id,version:TITLE_ACCEPTANCE,lookupMode:'title_artist',verifier:TITLE_VERIFIER,createdAt,samples:[]};
 await db.transaction(tx=>tx`UPDATE provider_smoke SET report=jsonb_set(report,'{acceptanceAttempts}',COALESCE(report->'acceptanceAttempts','[]'::jsonb)||${json([attempt])}::jsonb) WHERE provider='soundnet-review'`);
 for(const original of originals){
  signal?.throwIfAborted();let raw:unknown,latencyMs:number|null=null,bytes:number|null=null;let endpoint='title_artist';let expected:unknown;let result:Record<string,unknown>;let fatal=false;
  try{
   const track=await queue.trackMetadata(original.trackId);if(!track)throw new Error('TRACK_METADATA_MISSING');expected=track;
   const lookup=titleLookup(track);if((fingerprints.get(titleFingerprint(track))??0)>1)throw new Error('ACCEPTANCE_IDENTITY_COLLISION');
   const [cache]=await db.transaction(tx=>tx`SELECT raw,fetched_at,data_quality FROM audio_features WHERE track_id=${track.trackId} AND feature_version=${FEATURE_VERSION}`);
   let fetchedAt:string;
   if(cache){raw=cache.raw;endpoint='cached';fetchedAt=new Date(cache.fetched_at).toISOString();}
   else{log({acceptanceId:id,trackId:track.trackId,status:'requesting',endpoint});const response=await queue.dispatch(()=>client.fetch(track.trackId,signal,lookup),signal);raw=response.raw;latencyMs=response.latencyMs;bytes=response.bytes;fetchedAt=new Date().toISOString();}
   const verified=normalizeVerifiedTitle(raw,track,undefined,fetchedAt);
   result={trackId:track.trackId,primaryArtist:track.artists[0]!.name,status:'success',identityVerified:true,endpoint,originalEndpoint:cache?.data_quality?.requestEndpoint??(cache?'spotify_id':'title_artist'),expected:track,raw,fetchedAt,latencyMs,bytes,verifiedAt:new Date().toISOString(),identity:verified.dataQuality};
  }catch(error){
   if(error instanceof ProviderError){if(raw===undefined)raw=error.raw;if(error.code==='HTTP_429')await queue.cooldown(Math.max(1000,error.retryAfterMs));fatal=error.code==='HTTP_401'||error.code==='HTTP_403';if(fatal)await queue.cooldown(3600000);}
   const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'TITLE_SMOKE_FAILED';result={trackId:original.trackId,status:'failed',code,endpoint,expected,raw,latencyMs,bytes,verifiedAt:new Date().toISOString()};
  }
  // Append each sample under a row lock: interrupted runs retain prior evidence and
  // never replace the original failed smoke samples or unrelated diagnostic arrays.
  await db.transaction(async tx=>{const [current]=await tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review' FOR UPDATE`;const saved=current.report.acceptanceAttempts.find((a:any)=>a.id===id);if(!saved)throw new Error('ACCEPTANCE_ATTEMPT_MISSING');saved.samples.push(result);await tx`UPDATE provider_smoke SET report=${json(current.report)}::jsonb WHERE provider='soundnet-review'`;});
  log({acceptanceId:id,trackId:result.trackId,status:result.status,endpoint,latencyMs,code:result.code});if(fatal||signal?.aborted)break;
 }
 const [saved]=await db.transaction(tx=>tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review'`);
 try{validateTitleAcceptance(saved.report,id);return {id,passed:true};}catch{return {id,passed:false};}
}
/** Called only by the explicit operator approval command. Reverify the raw evidence
 * against current DB metadata, then promote caches and approval in one transaction. */
export async function approveTitleSmoke(db:Database,attemptId:string,rightsBasis?:string){
 return db.transaction(async tx=>{
  const [row]=await tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review' FOR UPDATE`;
  const accepted=validateTitleAcceptance(row?.report,attemptId);
  const evidence=row.report.acceptanceAttempts.find((a:any)=>a.id===attemptId);
  for(const sample of evidence.samples){
   const [record]=await tx`SELECT card FROM tracks WHERE track_id=${sample.trackId}`;const track=TrackCardSchema.parse(record?.card);
   if(track.artists[0]!.name!==sample.primaryArtist)throw new Error('ACCEPTANCE_METADATA_CHANGED');
   const normalized=normalizeVerifiedTitle(sample.raw,track,{permittedForTraining:Boolean(rightsBasis),...(rightsBasis?{rightsBasis}:{})},sample.fetchedAt);
   const [job]=await tx`SELECT status FROM soundnet_jobs WHERE track_id=${sample.trackId} AND feature_version=${FEATURE_VERSION} FOR UPDATE`;if(job?.status==='running')throw new Error('SMOKE_JOB_RUNNING');
   await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${sample.trackId},${FEATURE_VERSION},'soundnet',${json(normalized.raw)}::jsonb,${json(normalized.normalized)}::jsonb,${json({...normalized.dataQuality,acceptanceId:attemptId,operatorVerified:true,requestEndpoint:sample.endpoint==='cached'?sample.originalEndpoint:'title_artist'})}::jsonb,${normalized.fetchedAt}) ON CONFLICT DO NOTHING`;
   await tx`UPDATE soundnet_jobs SET status='success',error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE track_id=${sample.trackId} AND feature_version=${FEATURE_VERSION} AND status!='running'`;
  }
  await tx`INSERT INTO provider_smoke(provider,verified_at,report) VALUES('soundnet',now(),${json({...accepted,operatorReviewed:true})}::jsonb) ON CONFLICT(provider) DO UPDATE SET verified_at=excluded.verified_at,report=excluded.report`;
  return accepted.id;
 });
}
