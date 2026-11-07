import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';import {MusicaeQueue} from '../src/musicae-queue';
import {MusicaeWorker} from '../../../apps/api/src/jobs/soundnet/musicae-worker';import {MusicaeClient} from '../../../apps/api/src/jobs/soundnet/musicae-provider';import {createDemoQueue,demoTracks} from '@sortfm/contracts/fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Musicae worker',()=>{
 let db:Database,q:MusicaeQueue;let historical:any;const user='test:musicae-worker';const tracks=Array.from({length:10},(_,i)=>({...demoTracks[0]!,trackId:String(i+1).padStart(22,'0'),source:'spotify' as const,spotifyUri:`spotify:track:${String(i+1).padStart(22,'0')}` as const,durationMs:123456,isPlayable:true}));
 beforeAll(async()=>{db=new Database(url!,`test_musicae_worker_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);q=new MusicaeQueue(db);const repo=new Repository(db);await repo.upsertUser({id:user,spotifyId:null,displayName:'test',avatarUrl:null});await repo.upsertSavedTracks(tracks.map(track=>({userId:user,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved' as const})));await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:user,jobId:crypto.randomUUID(),pass:0,expectedMembershipRevision:0,sourceTotal:tracks.length,trackIds:tracks.map(t=>t.trackId),observedAt:new Date().toISOString()}));const item=createDemoQueue({limit:1,exposureId:()=>crypto.randomUUID()}).items[0]!;historical={userId:user,exposure:{...item.exposure,trackId:tracks[0]!.trackId},prediction:item.prediction,features:{featureVersion:'sortfm.features.v1',values:{energy:null},provenance:'spotify',permittedForTraining:true}};await repo.insertExposure(historical);await q.enqueueUser(user);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();});
 const raw=(ids:string[])=>({audio_features:ids.map((id,i)=>({id,uri:`spotify:track:${id}`,type:'audio_features',duration_ms:123456,energy:0.723,danceability:0.456,acousticness:0.123,instrumentalness:0,liveness:0.234,speechiness:0.034,valence:0.567,tempo:120,loudness:-6,key:0,mode:1}))});
 test('actual worker batches five, persists cache and resumes without refetching prior successes',async()=>{let calls=0;const starts:number[]=[];const client=new MusicaeClient('test',{fetch:async(url)=>{calls++;starts.push(performance.now());const ids=new URL(url).searchParams.get('ids')!.split(',');expect(ids).toHaveLength(5);return Response.json(raw(ids),{headers:{'x-ratelimit-requests-limit':'10000','x-ratelimit-requests-remaining':String(10000-calls)}});}});
  expect((await new MusicaeWorker(q,client,{rightsBasis:'generated fixture'}).run({maxRequests:1,userId:user})).reason).toBe('REQUEST_BUDGET');expect((await q.progress(user)).ready).toBe(5);
  expect((await new MusicaeWorker(new MusicaeQueue(db),client,{rightsBasis:'generated fixture'}).run({maxRequests:2,userId:user})).reason).toBe('COMPLETE');expect(calls).toBe(2);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(990);expect((await q.progress(user)).ready).toBe(10);
  expect((await new MusicaeWorker(q,client).run({maxRequests:2,userId:user})).requests).toBe(0);expect(calls).toBe(2);
 },60000);
 test('persisted response replay applies without network and without modifying exposure history',async()=>{
  await db.transaction(async tx=>{await tx`DELETE FROM musicae_features WHERE track_id=${tracks[0]!.trackId}`;await tx`UPDATE musicae_jobs SET status='pending',attempts=0 WHERE track_id=${tracks[0]!.trackId}`;await tx`UPDATE musicae_control SET next_start_at=clock_timestamp()-interval '1 second'`;});
  const job=await q.claim();if(job?.kind!=='request')throw Error();const response={raw:raw([tracks[0]!.trackId]),httpStatus:200,latencyMs:100,remaining:9997,limit:10000,resetSeconds:86400,retryAfterMs:0,bytes:200};await q.dispatch(job,async()=>response);await q.storeResponse(job,{response});await db.transaction(tx=>tx`UPDATE musicae_control SET quota_limit=NULL`);
  const client=new MusicaeClient('test',{fetch:async()=>{throw Error('NETWORK_MUST_NOT_RUN');}});const result=await new MusicaeWorker(q,client,{rightsBasis:'generated fixture'}).run({maxRequests:1,userId:user});expect(result.requests).toBe(0);expect(result.replayed).toBe(1);expect((await q.progress(user)).ready).toBe(10);expect(await new Repository(db).getExposure(user,historical.exposure.exposureId)).toEqual(historical);
 },60000);
 test('SoundNet wins overlapping cache projections and reruns preserve both provider records',async()=>{
  const normalized={featureVersion:'sortfm.features.v1',values:{energy:0.25},provenance:'soundnet',permittedForTraining:true,rightsBasis:'generated fixture'} as const;
  await db.transaction(tx=>tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${tracks[0]!.trackId},'sortfm.features.v1','soundnet','{}'::jsonb,${JSON.stringify(normalized)}::jsonb,'{}'::jsonb,clock_timestamp())`);
  const before=await db.transaction(tx=>tx`SELECT row_to_json(a) AS data FROM audio_features a`);
  await q.enqueueUser(user);const result=await new MusicaeWorker(q,new MusicaeClient('test',{fetch:async()=>{throw Error('NETWORK_MUST_NOT_RUN');}})).run({userId:user,maxRequests:1});expect(result.requests).toBe(0);
  const library=await new Repository(db).library(user);expect(library).toHaveLength(10);expect(library.find(t=>t.track.trackId===tracks[0]!.trackId)!.audioFeatures).toEqual(normalized);
  expect(await db.transaction(tx=>tx`SELECT row_to_json(a) AS data FROM audio_features a`)).toEqual(before);expect((await q.progress(user)).musicaeReady).toBe(10);
 },60000);
 test('effective status excludes terminal Musicae jobs covered by a winning SoundNet cache',async()=>{
  await db.transaction(async tx=>{await tx`DELETE FROM musicae_features WHERE track_id IN (${tracks[0]!.trackId},${tracks[1]!.trackId})`;await tx`UPDATE musicae_jobs SET status='unavailable',error_code='TRACK_UNAVAILABLE' WHERE track_id IN (${tracks[0]!.trackId},${tracks[1]!.trackId})`;});
  const progress=await q.progress(user);expect(progress.ready).toBe(9);expect(progress.unavailable).toBe(1);const status=await q.audioStatus(user);expect(status.failed).toBe(1);expect(status.status).toBe('failed');
 },60000);
 test('current locked plan state prevents another request after a Basic-plan response',async()=>{
  await db.transaction(async tx=>{await tx`UPDATE musicae_jobs SET status='pending',attempts=0,available_at=clock_timestamp()-interval '1 second' WHERE track_id=${tracks[1]!.trackId}`;await tx`UPDATE musicae_control SET request_count=0,quota_limit=NULL,remaining=NULL,next_start_at=clock_timestamp()-interval '1 second'`;});
  let calls=0;const client=new MusicaeClient('test',{fetch:async url=>{calls++;return Response.json(raw(new URL(url).searchParams.get('ids')!.split(',')),{headers:{'x-ratelimit-requests-limit':'10','x-ratelimit-requests-remaining':'9'}});}});
  const stalePermit=(await q.progress(user)).requests===0;
  const result=await new MusicaeWorker(q,client).run({userId:user,maxRequests:2});expect(calls).toBe(1);expect(result.reason).toBe('PRO_PLAN_NOT_VERIFIED');
  // Even a caller with a previously true permit must see locked current quota.
  expect(await q.claim(stalePermit)).toEqual({kind:'blocked',reason:'PRO_PLAN_NOT_VERIFIED'});
 },60000);
});
