import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createMlClient,createRepositoryMl} from '../../../apps/api/src/ml';
import {FeedbackWorker} from '../../../apps/api/src/reviews/feedback';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresCalibrationStore} from '../src/calibration';import {PostgresCalibrationBatchStore} from '../src/calibration-batch';import {PostgresA1Store} from '../src/a1-store';
import {row,prediction,now} from '../../../apps/api/src/calibration/test-fixtures';
import {selectCalibrationBatch,BATCH_ALGORITHM} from '../../../apps/api/src/calibration/batch-selection';
import type {CalibrationBatchDraft,ExposureInput} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable Batch2 isolation',()=>{
 let db:Database,repo:Repository,cal:PostgresCalibrationStore,batches:PostgresCalibrationBatchStore,draft:CalibrationBatchDraft;
 const owner='test:batch2';let tick=now;const time=()=>new Date(tick+=1000).toISOString();
 beforeAll(async()=>{
  db=new Database(url!,`test_batch2_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);cal=new PostgresCalibrationStore(db);batches=new PostgresCalibrationBatchStore(db);
  await repo.upsertUser({id:owner,spotifyId:null,displayName:'Batch test',avatarUrl:null});
  const candidates=Array.from({length:130},(_,i)=>{const r=row(i+1);return {track:r.track,features:{featureVersion:'sortfm.features.v1' as const,values:{saved_age_days:i,energy:i/130},provenance:'musicae' as const,permittedForTraining:true},prediction:{...prediction,removalProbability:.5}};});
  await repo.upsertSavedTracks(candidates.map(c=>({userId:owner,track:c.track,originalAddedAt:c.track.originalAddedAt,syncedAt:time(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:candidates.map(c=>c.track.trackId),sourceTotal:candidates.length,observedAt:time()}));
  draft={batchId:crypto.randomUUID(),seed:42,modelVersion:prediction.modelVersion,algorithmVersion:BATCH_ALGORITHM,selectedAt:time(),candidates,...selectCalibrationBatch(candidates,42)};
 },30000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30000);
 test('create concurrently persists one reproducible 70-item batch and restart reuses exposures',async()=>{
  const [a,b]=await Promise.all([batches.createCalibrationBatch(owner,draft),batches.createCalibrationBatch(owner,{...draft,batchId:crypto.randomUUID()})]);
  expect(a).toEqual(b);expect(a.entries).toHaveLength(70);expect(new Set(a.entries.map(e=>e.trackId)).size).toBe(70);
  expect(await new PostgresCalibrationBatchStore(db).calibrationBatch(owner,time())).toEqual(a);
  await expect(batches.createCalibrationBatch(owner,{...draft,seed:43})).rejects.toMatchObject({code:'BATCH_SEED_CONFLICT'});
  expect((await cal.calibrationCandidates(owner)).eligibleTrackIds.some(id=>a.entries.some(e=>e.trackId===id))).toBe(false);
 },30000);
 const label=async(e:{trackId:string;exposureId:string},value:0|1)=>cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{...e,label:value,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:time()});
 test('A labels never enter shared ML dataset; B/C train; Undo preserves exclusions and renews same frozen item',async()=>{
  const batch=(await batches.calibrationBatch(owner,time()))!;const a=batch.entries.find(e=>e.group==='A')!,b=batch.entries.find(e=>e.group==='B')!,c=batch.entries.find(e=>e.group==='C')!;
  const la=await label({trackId:a.trackId,exposureId:a.exposureId},1);await label({trackId:b.trackId,exposureId:b.exposureId},0);await label({trackId:c.trackId,exposureId:c.exposureId},1);
  expect((await repo.trainingExamples(owner)).examples.map(e=>[e.trackId,e.split])).toEqual([[b.trackId,'train'],[c.trackId,'train']]);
  const saved=(await batches.calibrationBatch(owner,time()))!;expect([saved.labeled,saved.trainingLabeled,saved.sealedLabeled]).toEqual([3,2,1]);
  const undone=await cal.undoCalibrationLabel({userId:owner,commandId:crypto.randomUUID(),labelId:la.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:time()});
  const renewed=(await batches.calibrationBatch(owner,undone.updatedAt))!.entries.find(e=>e.batchItemId===a.batchItemId)!;expect(renewed.exposureId).not.toBe(a.exposureId);expect(renewed.trackId).toBe(a.trackId);expect(renewed.selectedAt).toBe(a.selectedAt);
  await label({trackId:renewed.trackId,exposureId:renewed.exposureId},0);expect((await repo.trainingExamples(owner)).examples.some(e=>e.trackId===a.trackId)).toBe(false);
  const original=(await repo.getExposure(owner,a.exposureId))!;const future:ExposureInput={...original,exposure:{...original.exposure,exposureId:crypto.randomUUID(),servedAt:time()}};
  await expect(repo.insertExposure(future)).rejects.toMatchObject({code:'BATCH_TRACK_RESERVED'});await expect(cal.insertCalibrationExposure(future)).rejects.toMatchObject({code:'BATCH_TRACK_RESERVED'});
 },30000);
 test('Skip is durable, idempotent and replaces within group; skipped A stays sealed without a label',async()=>{
  const before=(await batches.calibrationBatch(owner,time()))!,a=before.entries.find(e=>e.group==='A'&&e.status==='pending')!;
  const input={exposureId:a.exposureId,idempotencyKey:createIdempotencyKey()};const first=await batches.skipCalibrationBatch(owner,input,time()),retry=await batches.skipCalibrationBatch(owner,input,time());expect(retry).toEqual(first);
  expect(first.entries).toHaveLength(71);expect(first.entries.find(e=>e.batchItemId===a.batchItemId)!.status).toBe('skipped');
  const replacement=first.entries.find(e=>e.replacementFor===a.batchItemId)!;expect(replacement.group).toBe('A');expect(replacement.assignment).toBe('sealed_evaluation');
  expect((await cal.calibrationHistory(owner)).items.some(e=>e.trackId===a.trackId)).toBe(false);
  await expect(label({trackId:a.trackId,exposureId:a.exposureId},0)).rejects.toMatchObject({code:'BATCH_ITEM_NOT_PENDING'});
  expect((await batches.calibrationBatchCandidates(owner)).eligibleTrackIds).not.toContain(a.trackId);
  const [effects]=await db.transaction(tx=>tx`SELECT (SELECT count(*)::int FROM review_work) AS work,(SELECT count(*)::int FROM spotify_mutations) AS mutations,(SELECT source_total FROM library_state WHERE user_id=${owner}) AS total`);expect(effects).toEqual({work:0,mutations:0,total:130});
 },30000);
 test('real C1 manual and automatic fits and evaluation never receive sealed rows',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sortfm-batch2-ml-'));
  const socket=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});const port=socket.port!;await socket.stop(true);
  const serviceUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
  const process=Bun.spawn(['uv','run','--no-sync','--directory',join(import.meta.dir,'../../../services/ml'),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...globalThis.process.env,UV_CACHE_DIR:'/tmp/sortfm-uv-cache',ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe'});
  try{
   let ready=false;for(let i=0;i<100;i++){ready=!!(await fetch(`${serviceUrl}/health`).catch(()=>null))?.ok;if(ready)break;await Bun.sleep(100);}expect(ready).toBe(true);
   const client=createMlClient({serviceUrl,sharedSecret}),adapter=createRepositoryMl({repository:repo,client});
   const manual=await adapter.fit(owner);expect(manual.trainedExamples).toBe(2);expect(manual.metrics.heldOutExamples).toBe(0);expect(manual.metrics.labeledExamples).toBe(2);
   const batch=(await batches.calibrationBatch(owner,time()))!,a=batch.entries.find(e=>e.group==='A'&&e.status==='pending')!;
   await label({trackId:a.trackId,exposureId:a.exposureId},1);
   const worker=new FeedbackWorker(repo,adapter,{now:()=>Date.now()});expect(await worker.runOnce()).toBe(true);await worker.close();
   const metrics=await adapter.evaluation(owner);expect(metrics.trainedExamples).toBe(2);expect(metrics.heldOutExamples).toBe(0);expect(metrics.labeledExamples).toBe(2);
   const frozen=(await repo.getExposure(owner,a.exposureId))!;
   await expect(adapter.observe({userId:owner,eventId:crypto.randomUUID(),decisionId:crypto.randomUUID(),exposureId:a.exposureId,trackId:a.trackId,feedbackRevision:(await repo.trainingExamples(owner)).feedbackRevision,operation:'upsert',label:1,features:frozen.features,occurredAt:time()})).rejects.toThrow('SEALED_EVALUATION_EXCLUDED');
   const still=await adapter.evaluation(owner);expect(still.labeledExamples).toBe(2);
  }finally{process.kill('SIGTERM');await process.exited;await rm(directory,{recursive:true,force:true});}
 },60000);
 test('a previously labeled then revoked track cannot be newly reserved, and publication rolls back all reservations',async()=>{
  // A new owner verifies that stale preparation cannot move historical feedback into evaluation.
  const other='test:batch2-race';await repo.upsertUser({id:other,spotifyId:null,displayName:'Race',avatarUrl:null});
  await repo.upsertSavedTracks(draft.candidates.map(c=>({userId:other,track:c.track,originalAddedAt:c.track.originalAddedAt,syncedAt:time(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:other,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:draft.candidates.map(c=>c.track.trackId),sourceTotal:130,observedAt:time()}));
  const a=draft.selected.find(e=>e.group==='A')!,existing=(await repo.getExposure(owner,(await batches.calibrationBatch(owner,time()))!.entries.find(e=>e.trackId===a.trackId)!.exposureId))!;
  const ex={...existing,userId:other,exposure:{...existing.exposure,exposureId:crypto.randomUUID(),servedAt:time()}};await cal.insertCalibrationExposure(ex);
  const l=await cal.createCalibrationLabel({userId:other,labelId:crypto.randomUUID(),request:{trackId:a.trackId,exposureId:ex.exposure.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'historical',createdAt:time()});
  await cal.undoCalibrationLabel({userId:other,commandId:crypto.randomUUID(),labelId:l.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'revoke',createdAt:time()});
  expect((await batches.calibrationBatchCandidates(other)).eligibleTrackIds).not.toContain(a.trackId);
  await expect(batches.createCalibrationBatch(other,{...draft,batchId:crypto.randomUUID(),selectedAt:time()})).rejects.toMatchObject({code:'BATCH_CANDIDATES_CHANGED'});
  expect(await batches.calibrationBatch(other,time())).toBeNull();
 },30000);
});
