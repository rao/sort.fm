import {connectDatabase,json} from '../../../../../packages/db/src/client';
import {Repository} from '../../../../../packages/db/src/repository';
import {SoundNetQueue} from '../../../../../packages/db/src/soundnet-queue';
import {FEATURE_VERSION} from '@sortfm/contracts';
import {SoundNetClient,ProviderError} from './provider';import {SoundNetWorker} from './worker';import {normalizeSoundNet} from './normalize';
const usage='Usage: bun apps/api/src/jobs/soundnet/cli.ts <enqueue|status|smoke|approve-smoke|run|retry-failed> [--user USER_ID]';
export async function main(args=process.argv.slice(2)){
 const command=args[0];if(!command||!['enqueue','status','smoke','approve-smoke','run','retry-failed'].includes(command))throw new Error(usage);
 const userIndex=args.indexOf('--user');const userId=userIndex<0?undefined:args[userIndex+1];
 if(['enqueue','status','smoke'].includes(command)&&!userId)throw new Error('--user is required');
 const db=connectDatabase();const queue=new SoundNetQueue(db);const stop=new AbortController();
 const shutdown=()=>stop.abort();process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
 try{
  if(command==='enqueue'){console.log({enqueued:await queue.enqueueUser(userId!)});return;}
  if(command==='status'){console.log(await queue.progress(userId!));return;}
  if(command==='retry-failed'){console.log({requeued:await queue.retryFailed()});return;}
  if(command==='approve-smoke'){
   const report=await db.transaction(async tx=>(await tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review'`)[0]?.report);
   if(!report||Date.now()-Date.parse(report.createdAt)>86400000||report.samples.length!==5||report.samples.some((s:any)=>s.status!=='success'))throw new Error('FIVE_RECENT_SUCCESSFUL_SMOKE_SAMPLES_REQUIRED');
   await queue.approveSmoke({...report,operatorReviewed:true});console.log({approved:true});return;
  }
  const key=process.env.SOUNDNET_RAPIDAPI_KEY;if(!key)throw new Error('SOUNDNET_RAPIDAPI_KEY_REQUIRED');const client=new SoundNetClient(key);
  if(command==='smoke'){
   const library=await new Repository(db).library(userId!);const byArtist=new Map<string,typeof library[number]>();
   for(const item of library)if(item.track.source==='spotify')byArtist.set(item.track.artists[0]!.name,item);
   const selected=[...byArtist.values()].slice(0,5);if(selected.length<5)throw new Error('IMPORT_FIVE_DISTINCT_ARTISTS_BEFORE_SMOKE');
   const samples:Record<string,unknown>[]=[];
   for(const {track} of selected){
    let observedRaw:unknown;
    try{
     // Reuse an existing successful sample/cache, including after an interrupted smoke run.
     const cached=await db.transaction(async tx=>(await tx`SELECT raw,normalized,data_quality,fetched_at FROM audio_features WHERE track_id=${track.trackId} AND feature_version=${FEATURE_VERSION}`)[0]);
     const response=cached?{raw:cached.raw,latencyMs:null,bytes:null}:await queue.dispatch(()=>client.fetch(track.trackId,stop.signal),stop.signal);
     observedRaw=response.raw;
     const normalized=normalizeSoundNet(response.raw,track.trackId,{permittedForTraining:Boolean(process.env.SOUNDNET_RIGHTS_BASIS),...(process.env.SOUNDNET_RIGHTS_BASIS?{rightsBasis:process.env.SOUNDNET_RIGHTS_BASIS}:{})},cached?new Date(cached.fetched_at).toISOString():undefined);
     await db.transaction(async tx=>{await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${track.trackId},${FEATURE_VERSION},'soundnet',${json(normalized.raw)}::jsonb,${json(normalized.normalized)}::jsonb,${json(normalized.dataQuality)}::jsonb,${normalized.fetchedAt}) ON CONFLICT DO NOTHING`;
      await tx`UPDATE soundnet_jobs SET status='success',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE track_id=${track.trackId} AND feature_version=${FEATURE_VERSION} AND status!='running'`;
     });
     const raw=response.raw as Record<string,unknown>;
     const sample={trackId:track.trackId,expectedTitle:track.title,expectedArtists:track.artists.map(a=>a.name),returnedTitle:raw.name??raw.title??null,returnedArtist:raw.artist??raw.artists??null,status:'success',cached:Boolean(cached),latencyMs:response.latencyMs,bytes:response.bytes,fields:Object.keys(raw),missingness:normalized.dataQuality,matchVerification:'operator_review_required'};
     samples.push(sample);console.log(sample);
    }catch(error){if(stop.signal.aborted)throw error;const code=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'SMOKE_FAILED';samples.push({trackId:track.trackId,status:'failed',code,raw:observedRaw??null});console.log({trackId:track.trackId,status:'failed',code});if(error instanceof ProviderError && error.retryAfterMs>0)await queue.cooldown(error.retryAfterMs);if(code==='HTTP_401'||code==='HTTP_403')break;}
   }
   await db.transaction(async tx=>{await tx`INSERT INTO provider_smoke(provider,verified_at,report) VALUES('soundnet-review',now(),${json({createdAt:new Date().toISOString(),samples})}::jsonb) ON CONFLICT(provider) DO UPDATE SET verified_at=excluded.verified_at,report=excluded.report`;});
   if(samples.length!==5||samples.some(sample=>sample.status!=='success'))process.exitCode=1;
   console.log({next:'Review raw cached responses against Spotify metadata, then run approve-smoke only if acceptable.'});return;
  }
  if(!await queue.smokeApproved())throw new Error('RUN_AND_REVIEW_SMOKE_BEFORE_BACKFILL');
  const worker=new SoundNetWorker(queue,client,{concurrency:Number(process.env.SOUNDNET_CONCURRENCY??3),maxConcurrency:Number(process.env.SOUNDNET_MAX_CONCURRENCY??5),rightsBasis:process.env.SOUNDNET_RIGHTS_BASIS,log:event=>console.log(JSON.stringify(event))});
  await worker.run(stop.signal);
 }finally{process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);await db.close();}
}
if(import.meta.main)main().catch(error=>{console.error(error instanceof Error&&(/^[A-Z0-9_]+$/.test(error.message)||error.message===usage||error.message==='--user is required')?error.message:'SOUNDNET_COMMAND_FAILED');process.exitCode=1;});
