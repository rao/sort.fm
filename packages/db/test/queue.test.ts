import {test,expect,beforeAll,afterAll,describe} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {SoundNetQueue} from '../src/soundnet-queue';
import {demoTracks} from '@sortfm/contracts/fixtures';import {normalizeSoundNet} from '../../../apps/api/src/jobs/soundnet/normalize';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable queue',()=>{
 const db=new Database(url!,`test_queue_${crypto.randomUUID().replaceAll('-','')}`);const repo=new Repository(db);const queue=new SoundNetQueue(db);const id='a'.repeat(22);
 beforeAll(async()=>{await migrate(db);await repo.upsertUser({id:'test:queue',spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertSavedTracks([{userId:'test:queue',track:{...demoTracks[0]!,trackId:id,source:'spotify',spotifyUri:`spotify:track:${id}`},originalAddedAt:new Date().toISOString(),syncedAt:new Date().toISOString(),currentStatus:'saved'}]);});
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();});
 test('enqueue dedupes, expired leases recover, stale completions cannot overwrite success',async()=>{
  await queue.enqueueUser('test:queue');await queue.enqueueUser('test:queue');const first=(await queue.claim(100))!;expect(first.trackId).toBe(id);expect(await queue.claim()).toBeNull();
  await db.transaction(async tx=>{await tx`UPDATE soundnet_jobs SET lease_until=now()-interval '1 second'`;});
  const second=(await queue.claim())!;expect(second.token).not.toBe(first.token);expect(second.attempts).toBe(2);
  const features=normalizeSoundNet({energy:70},id);expect(await queue.complete(first,features)).toBe(false);expect(await queue.complete(second,features)).toBe(true);
  await queue.enqueueUser('test:queue');expect(await queue.claim()).toBeNull();const status=await queue.progress('test:queue');expect(status.featuresReady).toBe(1);expect(status.featuresTotal).toBe(1);expect(status.missingness.danceability).toBe(1);
 });
 test('two dispatchers keep actual request starts under five in every rolling second',async()=>{
  const starts:number[]=[];const queue2=new SoundNetQueue(db);
  await Promise.all(Array.from({length:12},(_,i)=>(i%2?queue:queue2).dispatch(()=>{starts.push(performance.now());return Promise.resolve('ok');})));
  for(const t of starts)expect(starts.filter(s=>s>=t&&s<t+1000).length).toBeLessThanOrEqual(5);
 },15000);
 test('a crash after request start does not refund the persisted rate permit',async()=>{
  const starts:number[]=[];
  const faulty={transaction:async(work:any)=>db.transaction(async tx=>{const result=await work(tx);if(result?.response)throw new Error('simulated_commit_failure');return result;})} as Database;
  const worker=new SoundNetQueue(faulty);
  for(let i=0;i<6;i++)await expect(worker.dispatch(()=>{starts.push(performance.now());return Promise.resolve();})).rejects.toThrow('simulated_commit_failure');
  for(const t of starts)expect(starts.filter(s=>s>=t&&s<t+1000).length).toBeLessThanOrEqual(5);
 },15000);

 test('cache populated during a crashed worker lease reconciles without another provider call',async()=>{
  await db.transaction(async tx=>{await tx`UPDATE soundnet_jobs SET status='running',lease_token=${crypto.randomUUID()},lease_until=now()-interval '1 second' WHERE track_id=${id}`;});
  expect(await queue.claim()).toBeNull();expect(await queue.unfinished()).toBe(0);
 });
 test('retry exhaustion retains invalid raw results without poisoning the successful cache',async()=>{
  const other='b'.repeat(22);await repo.upsertSavedTracks([{userId:'test:queue',track:{...demoTracks[0]!,trackId:other,source:'spotify',spotifyUri:`spotify:track:${other}`},originalAddedAt:new Date().toISOString(),syncedAt:new Date().toISOString(),currentStatus:'saved'}]);await queue.enqueueUser('test:queue');
  const limited=new SoundNetQueue(db,1);const job=(await limited.claim())!;expect(await limited.fail(job,'INVALID_FEATURES',true,1000,{unexpected:'retained'})).toBe(true);expect(await limited.claim()).toBeNull();
  const [failure]=await db.transaction(tx=>tx`SELECT raw FROM soundnet_failures WHERE track_id=${other}`);expect(failure.raw).toEqual({unexpected:'retained'});
  expect((await limited.progress('test:queue')).failed).toBe(1);
 });

});
