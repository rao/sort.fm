import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {SoundNetQueue} from '../src/soundnet-queue';
import {demoTracks} from '@sortfm/contracts/fixtures';import {SoundNetClient} from '../../../apps/api/src/jobs/soundnet/provider';import {SoundNetWorker} from '../../../apps/api/src/jobs/soundnet/worker';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('guarded title worker persistence',()=>{
 let db:Database,queue:SoundNetQueue,repo:Repository;
 beforeAll(async()=>{db=new Database(url!,`test_title_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);queue=new SoundNetQueue(db);repo=new Repository(db);await repo.upsertUser({id:'test:title',spotifyId:null,displayName:'Test',avatarUrl:null});});
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();});
 async function seed(letter:string){const id=letter.repeat(22);await repo.upsertSavedTracks([{userId:'test:title',track:{...demoTracks[0]!,trackId:id,source:'spotify',spotifyUri:`spotify:track:${id}`,title:'Song - Live',artists:[{id:null,name:'Artist'}],durationMs:180000},originalAddedAt:new Date().toISOString(),syncedAt:new Date().toISOString(),currentStatus:'saved'}]);await queue.enqueueUser('test:title');return id;}
 test('five failures mean five separately rate-limited calls, evidence survives restart, no hidden second request',async()=>{
  const id=await seed('c');const starts:number[]=[],urls:string[]=[];
  for(let i=0;i<5;i++){
   const job=(await new SoundNetQueue(db).claim())!;
   await new SoundNetWorker(new SoundNetQueue(db),new SoundNetClient('secret',{fetch:async u=>{urls.push(u);starts.push(performance.now());return Response.json({error:'Failed to pull track data'});}}),{lookupMode:'title_artist',random:()=>0}).process(job);
   await db.transaction(tx=>tx`UPDATE soundnet_jobs SET available_at=now() WHERE track_id=${id}`);
  }
  expect(await queue.claim()).toBeNull();expect(starts.length).toBe(5);expect(urls.every(u=>new URL(u).pathname==='/pktx/analysis')).toBe(true);
  for(const start of starts)expect(starts.filter(t=>t>=start&&t<start+1000).length).toBeLessThanOrEqual(5);
  const rows=await db.transaction(tx=>tx`SELECT endpoint,outcome,raw FROM soundnet_attempts WHERE track_id=${id}`);
  expect(rows.length).toBe(5);expect(rows.every((r:any)=>r.endpoint==='title_artist'&&r.outcome==='PROVIDER_TRACK_UNAVAILABLE'&&r.raw.error==='Failed to pull track data')).toBe(true);
 },20000);
 test('wrong recording stays missing; verified response is atomically cached with attempt evidence',async()=>{
  await seed('d');const bad=(await queue.claim())!;
  await new SoundNetWorker(queue,new SoundNetClient('secret',{fetch:async()=>Response.json({title:'Song',artist:'Artist',id:Buffer.from('song-artist').toString('base64'),duration:'3:00',energy:40})}),{lookupMode:'title_artist'}).process(bad);
  const [failure]=await db.transaction(tx=>tx`SELECT outcome,raw FROM soundnet_attempts WHERE lease_token=${bad.token}`);expect(failure.outcome).toBe('IDENTITY_REJECTED');expect(failure.raw.energy).toBe(40);
  expect((await db.transaction(tx=>tx`SELECT 1 FROM audio_features WHERE track_id=${bad.trackId}`)).length).toBe(0);
  await seed('e');const good=(await queue.claim())!;
  await new SoundNetWorker(queue,new SoundNetClient('secret',{fetch:async()=>Response.json({title:'Song - Live',artist:'Artist',id:Buffer.from('song-live-artist').toString('base64'),duration:'3:00',energy:40})}),{lookupMode:'title_artist',rightsBasis:'reviewed'}).process(good);
  const [result]=await db.transaction(tx=>tx`SELECT a.data_quality,a.normalized,s.outcome,s.raw FROM audio_features a JOIN soundnet_attempts s USING(track_id,feature_version) WHERE a.track_id=${good.trackId}`);
  expect(result.outcome).toBe('success');expect(result.raw.energy).toBe(40);expect(result.data_quality.identityVerified).toBe(true);expect(result.normalized.permittedForTraining).toBe(true);
 });
 test('crashed attempt remains auditable and stale lease cannot overwrite its replacement',async()=>{
  await seed('f');const old=(await queue.claim())!;expect(await queue.beginAttempt(old,'title_artist')).not.toBeNull();expect(await queue.beginAttempt(old,'title_artist')).toBeNull();
  await db.transaction(tx=>tx`UPDATE soundnet_jobs SET lease_until=now()-interval '1 second' WHERE track_id=${old.trackId}`);
  const fresh=(await queue.claim())!;expect(await queue.beginAttempt(fresh,'title_artist')).not.toBeNull();expect(await queue.fail(old,'TIMEOUT',true,0,{old:true})).toBe(false);expect(await queue.fail(fresh,'TIMEOUT',true,0,{fresh:true})).toBe(true);
  const rows=await db.transaction(tx=>tx`SELECT lease_token,outcome,raw FROM soundnet_attempts WHERE track_id=${old.trackId}`);
  expect(rows.find((r:any)=>r.lease_token===old.token).outcome).toBe('started');expect(rows.find((r:any)=>r.lease_token===fresh.token).raw).toEqual({fresh:true});
 });
});
