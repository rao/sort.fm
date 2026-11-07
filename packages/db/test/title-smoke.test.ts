import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database,json} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {SoundNetQueue} from '../src/soundnet-queue';
import {demoTracks} from '@sortfm/contracts/fixtures';import {SoundNetClient} from '../../../apps/api/src/jobs/soundnet/provider';import {normalizeSoundNet} from '../../../apps/api/src/jobs/soundnet/normalize';import {titleSmoke,approveTitleSmoke} from '../../../apps/api/src/jobs/soundnet/title-smoke';import {TITLE_VERIFIER} from '../../../apps/api/src/jobs/soundnet/identity';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('title acceptance and migration',()=>{
 let db:Database,queue:SoundNetQueue,repo:Repository;let applied:string[];
 const originals=Array.from({length:5},(_,i)=>({trackId:String(i).repeat(22),status:i?'failed':'success',code:i?'TIMEOUT':undefined}));
 beforeAll(async()=>{db=new Database(url!,`test_title_smoke_${crypto.randomUUID().replaceAll('-','')}`);applied=(await migrate(db)).applied;queue=new SoundNetQueue(db);repo=new Repository(db);await repo.upsertUser({id:'test:smoke',spotifyId:null,displayName:'Test',avatarUrl:null});
  for(let i=0;i<5;i++){const id=String(i).repeat(22);await repo.upsertSavedTracks([{userId:'test:smoke',track:{...demoTracks[0]!,trackId:id,source:'spotify',spotifyUri:`spotify:track:${id}`,title:`Song ${i}`,artists:[{id:null,name:`Artist ${i}`}],durationMs:180000},originalAddedAt:new Date().toISOString(),syncedAt:new Date().toISOString(),currentStatus:'saved'}]);}
  const v=normalizeSoundNet({title:'Song 0',artist:'Artist 0',id:Buffer.from('song-0-artist-0').toString('base64'),duration:'3:00',energy:55},'0'.repeat(22));
  await db.transaction(async tx=>{await tx`INSERT INTO provider_smoke(provider,verified_at,report) VALUES('soundnet-review',now(),${json({samples:originals,diagnostics:[{retained:true}]})}::jsonb)`;await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${v.trackId},'sortfm.features.v1','soundnet',${json(v.raw)}::jsonb,${json(v.normalized)}::jsonb,${json(v.dataQuality)}::jsonb,${v.fetchedAt})`;});
  await queue.enqueueUser('test:smoke');
 });
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();});
 test('migration applies, repeats without changes, and failed migration rolls back',async()=>{
  expect(applied).toContain('011_soundnet_attempts.sql');expect((await migrate(db)).applied).toEqual([]);
  const broken=new Database(url!,`test_title_rollback_${crypto.randomUUID().replaceAll('-','')}`);
  try{await broken.sql.unsafe(`CREATE SCHEMA "${broken.schema}"`);await broken.sql.unsafe(`CREATE TABLE "${broken.schema}".soundnet_attempts(dummy int)`);await expect(migrate(broken)).rejects.toThrow();
   const [state]=await broken.sql`SELECT to_regclass(${`${broken.schema}.users`}) AS users,to_regclass(${`${broken.schema}.schema_migrations`}) AS migrations`;expect(state.users).toBeNull();expect(state.migrations).toBeNull();
  }finally{await broken.sql.unsafe(`DROP SCHEMA "${broken.schema}" CASCADE`);await broken.close();}
 });
 test('separate attempt preserves original evidence, no diagnostic autoapproval, then explicit atomic verified promotion',async()=>{
  await queue.approveSmoke({samples:originals});expect(await queue.smokeApproved()).toBe(true);expect(await queue.smokeApproved('title_artist',TITLE_VERIFIER)).toBe(false);
  let calls=0;const client=new SoundNetClient('secret',{fetch:async u=>{calls++;const url=new URL(u);const i=url.searchParams.get('song')!.split(' ')[1];return Response.json({title:`Song ${i}`,artist:`Artist ${i}`,id:Buffer.from(`song-${i}-artist-${i}`).toString('base64'),duration:'3:00',energy:55});}});
  const result=await titleSmoke(db,queue,client,undefined,()=>{});expect(result.passed).toBe(true);expect(calls).toBe(4);expect(await queue.smokeApproved('title_artist',TITLE_VERIFIER)).toBe(false);
  const [before]=await db.transaction(tx=>tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review'`);expect(before.report.samples).toEqual(JSON.parse(JSON.stringify(originals)));expect(before.report.diagnostics).toEqual([{retained:true}]);expect(before.report.acceptanceAttempts[0].samples[0].endpoint).toBe('cached');
  expect((await db.transaction(tx=>tx`SELECT 1 FROM audio_features`)).length).toBe(1);
  // A plausible changed recording must fail re-verification and roll back all promotions.
  await db.transaction(tx=>tx`UPDATE tracks SET card=jsonb_set(card,'{title}','"Song 4 - Live"'::jsonb) WHERE track_id=${'4'.repeat(22)}`);
  await expect(approveTitleSmoke(db,result.id,'reviewed')).rejects.toThrow();expect((await db.transaction(tx=>tx`SELECT 1 FROM audio_features`)).length).toBe(1);
  await db.transaction(tx=>tx`UPDATE tracks SET card=jsonb_set(card,'{title}','"Song 4"'::jsonb) WHERE track_id=${'4'.repeat(22)}`);
  expect(await approveTitleSmoke(db,result.id,'reviewed')).toBe(result.id);expect(await queue.smokeApproved('title_artist',TITLE_VERIFIER)).toBe(true);expect(await queue.smokeApproved()).toBe(false);expect(await queue.smokeApproved('title_artist','outdated')).toBe(false);
  expect((await db.transaction(tx=>tx`SELECT 1 FROM audio_features`)).length).toBe(5);expect(await queue.unfinished()).toBe(0);
  const [approval]=await db.transaction(tx=>tx`SELECT report FROM provider_smoke WHERE provider='soundnet'`);expect(approval.report.id).toBe(result.id);
 },15000);
 test('known fingerprint collisions in the five-track candidate set remain unverified without calls',async()=>{
  await db.transaction(async tx=>{
   await tx`UPDATE tracks SET card=jsonb_set(jsonb_set(card,'{title}','"Song Live"'::jsonb),'{artists}','[{"id":null,"name":"Artist"}]'::jsonb) WHERE track_id=${'0'.repeat(22)}`;
   await tx`UPDATE tracks SET card=jsonb_set(jsonb_set(card,'{title}','"Song"'::jsonb),'{artists}','[{"id":null,"name":"Live Artist"}]'::jsonb) WHERE track_id=${'1'.repeat(22)}`;
  });
  let calls=0;const result=await titleSmoke(db,queue,new SoundNetClient('secret',{fetch:async()=>{calls++;throw new Error('must not fetch');}}),undefined,()=>{});
  expect(result.passed).toBe(false);expect(calls).toBe(0);
  const [row]=await db.transaction(tx=>tx`SELECT report FROM provider_smoke WHERE provider='soundnet-review'`);
  const attempt=row.report.acceptanceAttempts.find((a:any)=>a.id===result.id);
  expect(attempt.samples.slice(0,2).map((s:any)=>s.code)).toEqual(['ACCEPTANCE_IDENTITY_COLLISION','ACCEPTANCE_IDENTITY_COLLISION']);
  await expect(approveTitleSmoke(db,result.id)).rejects.toThrow();
 });

});
