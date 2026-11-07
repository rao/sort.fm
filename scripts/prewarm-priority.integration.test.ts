/** Opt-in real PostgreSQL/Tiger proof. All writes are synthetic setup in one disposable schema. */
import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database,json,type Transaction} from '../packages/db/src/client';
import {migrate} from '../packages/db/src/migrate';
import {Repository} from '../packages/db/src/repository';
import {PostgresCalibrationStore} from '../packages/db/src/calibration';
import {PostgresA1Store} from '../packages/db/src/a1-store';
import {demoTracks,createDemoQueue} from '../packages/contracts/src/fixtures';
import {createIdempotencyKey} from '../packages/contracts/src/client';
import type {ExposureInput,ReviewResult} from '../packages/contracts/src/index';
import {createDatabasePrewarmPort} from './prewarm-database';
import {readPrewarmPriority} from '../apps/api/src/calibration/prewarm';
const url=process.env.PREWARM_TEST_DATABASE_URL;
const now=Date.parse('2026-11-07T22:00:00Z'),iso=(age=0)=>new Date(now-age).toISOString();
const query={since:iso(1800000),limit:250};
describe.skipIf(!url)('private prewarm database snapshot',()=>{
 let db:Database,repo:Repository,cal:PostgresCalibrationStore;
 beforeAll(async()=>{db=new Database(url!,`test_prewarm_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);cal=new PostgresCalibrationStore(db);},30000);
 afterAll(async()=>{if(db){if(!/^test_prewarm_[a-f0-9]{32}$/.test(db.schema))throw Error('UNSAFE_TEST_SCHEMA');await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},30000);
 async function seed(userId:string,base:number,n:number){
  await repo.upsertUser({id:userId,spotifyId:null,displayName:'Authored fixture',avatarUrl:null});
  const tracks=Array.from({length:n},(_,i)=>({...demoTracks[0]!,trackId:String(base+i).padStart(22,'0'),source:'spotify' as const,spotifyUri:`spotify:track:${String(base+i).padStart(22,'0')}` as const,isPlayable:true}));
  await repo.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:iso(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:tracks.map(t=>t.trackId),sourceTotal:n,observedAt:iso()}));
  return tracks.map(t=>t.trackId);
 }
 function input(userId:string,trackId:string,position=0,age=1000):ExposureInput{
  const item=createDemoQueue({limit:1,servedAt:iso(age),exposureId:()=>crypto.randomUUID()}).items[0]!;
  return {userId,exposure:{...item.exposure,trackId,position},prediction:item.prediction,features:{featureVersion:'sortfm.features.v1',values:{energy:null},provenance:'spotify',permittedForTraining:true}};
 }
 async function issued(userId:string,trackId:string,purpose:'review'|'calibration',position=0,age=1000){const e=input(userId,trackId,position,age);await db.transaction(tx=>tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${e.exposure.exposureId},${userId},${trackId},${json(e)}::jsonb,${e.exposure.servedAt},${purpose})`);return e;}
 async function decision(userId:string,trackId:string,status:ReviewResult['status'],current=true){
  const e=await issued(userId,trackId,'review');const id=crypto.randomUUID(),key=createIdempotencyKey();
  const request={trackId,exposureId:e.exposure.exposureId,idempotencyKey:key,action:'SKIP' as const};
  const result:ReviewResult={...request,decisionId:id,mode:'spotify',status,mutationStep:status==='PENDING'?'PENDING':'NONE',liked:null,archived:null,canUndo:status==='COMPLETE',label:null,labelState:'inactive',feedbackRevision:0,error:null,createdAt:iso(),updatedAt:iso()};
  await db.transaction(async tx=>{await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,result,created_at) VALUES(${id},${userId},${trackId},${e.exposure.exposureId},${key},'fixture',${json(request)}::jsonb,${json(result)}::jsonb,${iso()})`;await tx`INSERT INTO exposure_consumptions(user_id,exposure_id,decision_id) VALUES(${userId},${e.exposure.exposureId},${id})`;if(current)await tx`INSERT INTO current_decisions(user_id,track_id,decision_id) VALUES(${userId},${trackId},${id})`;});return id;
 }
 async function label(e:ExposureInput,revoked:boolean,revision=1){
  const request={trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,idempotencyKey:crypto.randomUUID(),label:0};
  await db.transaction(tx=>tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revoked,revision,split,created_at,updated_at) VALUES(${crypto.randomUUID()},${e.userId},${e.exposure.trackId},${e.exposure.exposureId},${request.idempotencyKey},'fixture',${json(request)}::jsonb,0,${revoked?null:0},${revoked},${revision},'train',${iso()},${iso()})`);
 }
 async function digest(){return db.transaction(async tx=>{const tables=await tx`SELECT tablename FROM pg_tables WHERE schemaname=${db.schema} ORDER BY tablename`;const rows=[];for(const t of tables){const [r]=await tx.unsafe(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM "${db.schema}"."${t.tablename}" t`);rows.push({table:t.tablename,...r});}return rows;});}
 test('matches authoritative D eligibility, excludes foreign/blocked tracks, and changes no rows',async()=>{
  const user='test:prewarm:eligibility',ids=await seed(user,100,14);await seed('test:prewarm:other',500,1);
  await db.transaction(async tx=>{await tx`DELETE FROM library_membership WHERE user_id=${user} AND track_id=${ids[1]!}`;await tx`UPDATE tracks SET card=jsonb_set(card,'{isPlayable}','false') WHERE track_id=${ids[2]!}`;await tx`UPDATE saved_tracks SET current_status='archived' WHERE user_id=${user} AND track_id=${ids[8]!}`;await tx`UPDATE saved_tracks SET current_status='deferred' WHERE user_id=${user} AND track_id=${ids[9]!}`;});
  await label(await issued(user,ids[3]!,'calibration'),false);await decision(user,ids[4]!,'COMPLETE');await decision(user,ids[5]!,'PENDING',false);await decision(user,ids[6]!,'FAILED_RETRYABLE',false);
  const d=await decision(user,ids[7]!,'COMPLETE',false),command=crypto.randomUUID();
  await db.transaction(async tx=>{await tx`INSERT INTO undo_commands(command_id,user_id,decision_id,idempotency_key,request_fingerprint,payload,created_at) VALUES(${command},${user},${d},${crypto.randomUUID()},'fixture','{}',${iso()})`;await tx`INSERT INTO review_work(command_id,user_id,decision_id,operation) VALUES(${command},${user},${d},'undo')`;await tx`INSERT INTO review_work_leases(user_id,command_id,lease_id,lease_until,worker_id) VALUES(${user},${command},${crypto.randomUUID()},${iso(3600000)},'expired-fixture')`;});
  await decision(user,ids[10]!,'FAILED_TERMINAL');await decision(user,ids[11]!,'UNDONE');await decision(user,ids[12]!,'PENDING');await label(await issued(user,ids[13]!,'calibration'),true);
  const expected=[ids[0]!,ids[9]!,ids[10]!,ids[11]!,ids[13]!],before=await digest();
  const port=createDatabasePrewarmPort(db,now),snapshot=await port.readPrewarmSnapshot(user,query);
  expect(snapshot.eligibleTrackIds).toEqual(expected);expect(snapshot.eligibleTrackIds).toEqual((await cal.calibrationCandidates(user)).eligibleTrackIds);
  expect(snapshot.library.map(r=>r.track.trackId)).not.toContain(ids[1]!);expect(snapshot.library).toHaveLength(13);
  expect((await readPrewarmPriority(port,user,{now})).sort()).toEqual([...expected].sort() as string[]);
  await expect(port.readPrewarmSnapshot('test:missing',query)).rejects.toThrow('USER_NOT_FOUND');
  expect(await digest()).toEqual(before);
 },30000);
 test('filters both consumed namespaces before the bound and preserves timestamp/purpose/position batches',async()=>{
  const user='test:prewarm:batches',ids=await seed(user,600,5);
  const consumed=Array.from({length:255},(_,i)=>({input:input(user,ids[4]!,i,100),labelId:crypto.randomUUID(),key:crypto.randomUUID(),revision:i+1}));
  await db.transaction(async tx=>{
   await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) SELECT (v->'input'->'exposure'->>'exposureId')::uuid,${user},${ids[4]!},v->'input',(v->'input'->'exposure'->>'servedAt')::timestamptz,'calibration' FROM jsonb_array_elements(${json(consumed)}::jsonb) v`;
   await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revoked,revision,split,created_at,updated_at) SELECT (v->>'labelId')::uuid,${user},${ids[4]!},(v->'input'->'exposure'->>'exposureId')::uuid,(v->>'key')::uuid,'fixture','{}'::jsonb,0,NULL,true,(v->>'revision')::int,'train',${iso()}::timestamptz,${iso()}::timestamptz FROM jsonb_array_elements(${json(consumed)}::jsonb) v`;
  });
  await decision(user,ids[3]!,'UNDONE',false); // Consumed even after Undo.
  await issued(user,ids[3]!,'review',0,2000);await issued(user,ids[2]!,'review',0);await issued(user,ids[1]!,'calibration',1);await issued(user,ids[0]!,'calibration',0);
  await issued(user,ids[4]!,'calibration',0,-1000); // Future records cannot crowd out the bound.
  await issued(user,ids[4]!,'calibration',0,1800001);
  const before=await digest(),port=createDatabasePrewarmPort(db,now),s=await port.readPrewarmSnapshot(user,{...query,limit:3});
  expect(s.recentExposures.map(e=>[e.trackId,e.purpose,e.position,e.consumed])).toEqual([[ids[0]!,'calibration',0,false],[ids[1]!,'calibration',1,false],[ids[2]!,'review',0,false]]);
  expect(await readPrewarmPriority(port,user,{now,limit:4})).toEqual(ids.slice(0,4));expect(await digest()).toEqual(before);
  await expect(port.readPrewarmSnapshot(user,{...query,limit:251})).rejects.toThrow();
 },60000);
 test('a concurrent membership change cannot mix the library with later eligibility or consumption reads',async()=>{
  const user='test:prewarm:race',ids=await seed(user,900,2);const consumed=await issued(user,ids[0]!,'calibration');
  let changed=false,settings:unknown;
  // Wrap the real SQL transport to interleave a second connection after readLibrary.
  // Production has no test hooks, and every adapter query still executes in PostgreSQL.
  const sql=new Proxy(db.sql,{get(target,key){if(key!=='begin')return Reflect.get(target,key,target);return async(options:string,work:(tx:Transaction)=>unknown)=>target.begin(options,async tx=>{
   [settings]=await tx`SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`;
   const tapped=new Proxy(tx,{apply(target,_this,args){const result=Reflect.apply(target,tx,args);if(String(args[0]).includes('SELECT t.card,s.original_added_at'))return Promise.resolve(result).then(async rows=>{await label(consumed,false);await db.transaction(t=>t`DELETE FROM library_membership WHERE user_id=${user} AND track_id=${ids[0]!}`);changed=true;return rows;});return result;}});
   return work(tapped);
  });}});
  const observed=createDatabasePrewarmPort({sql,schema:db.schema} as Database,now);
  const s=await observed.readPrewarmSnapshot(user,query);
  expect(changed).toBe(true);expect(settings).toEqual({readonly:'on',isolation:'repeatable read'});expect(s.library.map(r=>r.track.trackId)).toEqual(ids);expect(s.eligibleTrackIds).toEqual(ids);expect(s.recentExposures[0]!.trackId).toBe(ids[0]!);
  const fresh=await createDatabasePrewarmPort(db,now).readPrewarmSnapshot(user,query);expect(fresh.library.map(r=>r.track.trackId)).toEqual([ids[1]!]);expect(fresh.eligibleTrackIds).toEqual([ids[1]!]);expect(fresh.recentExposures).toHaveLength(0);
 },30000);
 test('CLI exports a private priority file without logging IDs or changing database rows',async()=>{
  const user='test:prewarm:cli',ids=await seed(user,950,2),directory=await realpath(await mkdtemp(join(tmpdir(),'sortfm-prewarm-cli-'))),output=join(directory,'selection','priority.json');
  try{
   const before=await digest();
   const child=Bun.spawn([process.execPath,join(import.meta.dir,'prewarm-priority.ts'),'--user-id',user,'--output',output,'--limit','2'],{env:{PATH:process.env.PATH,DATABASE_URL:url!,DATABASE_SCHEMA:db.schema},stdout:'pipe',stderr:'pipe'});
   const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect(code).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({count:2,path:output});expect(stdout).not.toContain(user);for(const id of ids)expect(stdout).not.toContain(id);
   expect(JSON.parse(await readFile(output,'utf8')).sort()).toEqual(ids);expect((await stat(output)).mode&0o777).toBe(0o600);expect((await stat(join(directory,'selection'))).mode&0o777).toBe(0o700);expect(await digest()).toEqual(before);
  }finally{await rm(directory,{recursive:true,force:true});}
 },30000);

});
