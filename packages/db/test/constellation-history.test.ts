import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {Database,json} from '../src/client';
import {migrate} from '../src/migrate';
import {Repository} from '../src/repository';
import {PostgresA1Store} from '../src/a1-store';
import {PostgresConstellationStore} from '../src/constellation';
import {PostgresCalibrationExperimentStore} from '../src/calibration-experiment';
import {PostgresCalibrationBatchStore} from '../src/calibration-batch';
import {PostgresCalibrationStore} from '../src/calibration';
import {reviewExclusionManifestDigest} from '../src/review-exclusions';
import {experimentDraft,experimentSeal} from './calibration-experiment-fixtures';
import {row,prediction} from '../../../apps/api/src/calibration/test-fixtures';
import {selectCalibrationBatch,BATCH_ALGORITHM} from '../../../apps/api/src/calibration/batch-selection';

const url=process.env.TEST_DATABASE_URL,at=()=>new Date().toISOString(),id=(n:number)=>String(n).padStart(22,'0');
const observedAt='2026-01-02T03:04:05.000Z';
const features={featureVersion:'sortfm.features.v1',provenance:'musicae',permittedForTraining:true,values:{energy:0,happiness:null,tempo_bpm:125,loudness_db:-7,saved_age_days:999,kept_centroid_distance:3}};
describe.skipIf(!url)('retained constellation history PostgreSQL projection',()=>{
 let db:Database,repo:Repository,store:PostgresConstellationStore;
 beforeAll(async()=>{db=new Database(url!,`test_graph_history_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);store=new PostgresConstellationStore(db);},60000);
 afterAll(async()=>{if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);
 async function seed(n=8){
  const owner=`test:graph-history:${crypto.randomUUID()}`;
  await repo.upsertUser({id:owner,spotifyId:null,displayName:'Synthetic history owner',avatarUrl:null});
  await repo.upsertSavedTracks(Array.from({length:n},(_,i)=>({userId:owner,track:row(i+1).track,originalAddedAt:at(),syncedAt:at(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:Array.from({length:n},(_,i)=>id(i+1)),sourceTotal:n,observedAt}));
  return owner;
 }
 async function feedback(owner:string,n:number,options:{source?:'review'|'calibration';split?:'train'|'holdout';label?:0|1|null;revision?:number;permitted?:boolean;action?:'KEEP'|'ARCHIVE'|'UNLIKE'|'SKIP';status?:string}={}){
  const {source='review',split='train',label=0,revision=1,permitted=true,action=label===1?'UNLIKE':'KEEP',status='COMPLETE'}=options;
  const decision=crypto.randomUUID(),exposure=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${exposure},${owner},${id(n)},${json({features:{...features,permittedForTraining:permitted}})}::jsonb,clock_timestamp(),${source==='calibration'?'calibration':'review'})`;
   if(source==='calibration'){
    await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revoked,revision,split,created_at,updated_at) VALUES(${decision},${owner},${id(n)},${exposure},${crypto.randomUUID()},'fixture','{}',${label??0},${label},${label===null},${revision},${split},clock_timestamp(),clock_timestamp())`;
   }else{
    await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,result,created_at) VALUES(${decision},${owner},${id(n)},${exposure},${crypto.randomUUID()},'fixture',${json({action})}::jsonb,${json({status,action})}::jsonb,clock_timestamp())`;
    await tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${owner},${decision},${revision},${label},${label===null},${split},clock_timestamp())`;
   }
  });return {decision,exposure};
 }
 const snapshot=()=>db.transaction(async tx=>{
  const result:Record<string,unknown>={};
  for(const table of ['users','saved_tracks','library_membership','library_state','exposures','review_decisions','feedback','calibration_labels','undo_commands','interaction_events','soundnet_jobs','musicae_jobs','policy_selection_intents'])result[table]=await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
  return result;
 });

 test('retains archived, unliked and unlabeled history with membership independent of labels and status',async()=>{
  const owner=await seed();
  await feedback(owner,1,{label:1,action:'ARCHIVE'});await feedback(owner,2,{label:1});
  await feedback(owner,3,{source:'calibration',label:1});await feedback(owner,4,{source:'calibration',label:0});
  await feedback(owner,6,{label:0});await feedback(owner,7,{label:1});
  await db.transaction(async tx=>{
   await tx`DELETE FROM library_membership WHERE user_id=${owner} AND track_id IN (${id(1)},${id(2)},${id(5)},${id(6)})`;
   await tx`UPDATE saved_tracks SET current_status='archived' WHERE user_id=${owner} AND track_id=${id(1)}`;
   await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${owner} AND track_id IN (${id(2)},${id(7)})`;
   await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${id(1)},'sortfm.features.v1','soundnet','{}',${json({...features,provenance:'soundnet'})}::jsonb,'{}',clock_timestamp()) ON CONFLICT DO NOTHING`;
  });
  const before=await snapshot(),result=await store.constellationHistory(owner);expect(await snapshot()).toEqual(before);
  expect(result.userId).toBe(owner);expect(result.membershipSyncedAt).toBe(observedAt);
  expect(result.tracks.map(t=>[t.id,t.label,t.isLiked])).toEqual([
   [id(1),'remove',false],[id(2),'remove',false],[id(3),'remove',true],[id(4),'keep',true],
   [id(5),null,false],[id(6),'keep',false],[id(7),'remove',true],[id(8),null,true],
  ]);
  expect(result.tracks[0]!.audio).toEqual({energy:0,happiness:null,tempo_bpm:125,loudness_db:-7});
  expect(result.tracks[1]!.audio).toEqual({});
  expect((await store.constellation(owner)).tracks.map(t=>t.id)).toEqual([id(3),id(4),id(8)]);
  const other=await seed(1);expect((await store.constellationHistory(other)).tracks.map(t=>[t.label,t.isLiked])).toEqual([[null,true]]);
 });
 test('latest eligible feedback wins and revoked or superseding null feedback cannot revive earlier labels',async()=>{
  const owner=await seed();
  await feedback(owner,1,{source:'calibration',label:0});await feedback(owner,1,{label:1,revision:2});
  await feedback(owner,2,{label:1});await feedback(owner,2,{source:'calibration',label:null,revision:2});
  await feedback(owner,3,{source:'calibration',label:1});await feedback(owner,3,{label:null,revision:2,action:'SKIP'});
  await feedback(owner,4,{label:1,permitted:false});await feedback(owner,5,{source:'calibration',label:1,permitted:false});
  await feedback(owner,6,{label:1,status:'FAILED_TERMINAL'});await feedback(owner,7,{label:1,action:'KEEP'});
  expect((await store.constellationHistory(owner)).tracks.map(t=>t.label)).toEqual(['remove',null,null,null,null,null,null,null]);
 });
 test('pending decisions and Undo hide tracks until settled restoration returns an unlabeled current member',async()=>{
  const owner=await seed(4),undo=await feedback(owner,1,{label:1}),pending=await feedback(owner,2,{status:'PENDING'});
  await feedback(owner,3,{status:'FAILED_RETRYABLE'});
  await db.transaction(async tx=>{
   await tx`DELETE FROM library_membership WHERE user_id=${owner} AND track_id=${id(1)}`;
   await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${owner} AND track_id=${id(1)}`;
   await tx`INSERT INTO undo_commands(command_id,user_id,decision_id,idempotency_key,request_fingerprint,payload,created_at) VALUES(${crypto.randomUUID()},${owner},${undo.decision},${crypto.randomUUID()},'fixture','{}',clock_timestamp())`;
  });
  expect((await store.constellationHistory(owner)).tracks.map(t=>t.id)).toEqual([id(4)]);
  await db.transaction(async tx=>{
   await tx`UPDATE undo_commands SET settled_at=clock_timestamp() WHERE user_id=${owner}`;
   await tx`UPDATE review_decisions SET result='{"status":"UNDONE","action":"UNLIKE"}' WHERE decision_id=${undo.decision}`;
   await tx`UPDATE feedback SET label=NULL,revoked=true,revision=2 WHERE user_id=${owner} AND decision_id=${undo.decision}`;
   await tx`INSERT INTO library_membership(user_id,track_id,job_id,pass) SELECT user_id,${id(1)},job_id,pass FROM library_state WHERE user_id=${owner}`;
   await tx`UPDATE review_decisions SET result=NULL WHERE decision_id=${pending.decision}`;
  });
  const restored=await store.constellationHistory(owner);expect(restored.tracks.map(t=>[t.id,t.label,t.isLiked])).toEqual([[id(1),null,true],[id(4),null,true]]);expect(restored.membershipSyncedAt).toBe(observedAt);
 });
 test('ever-held-out feedback excludes archived history despite newer train labels and forbidden data changes',async()=>{
  const owner=await seed();await feedback(owner,8,{source:'calibration',split:'holdout',label:null});
  await db.transaction(async tx=>{await tx`DELETE FROM library_membership WHERE user_id=${owner} AND track_id=${id(8)}`;await tx`UPDATE saved_tracks SET current_status='archived' WHERE user_id=${owner} AND track_id=${id(8)}`;});
  const baseline=await store.constellationHistory(owner);expect(baseline.tracks).toHaveLength(7);
  await feedback(owner,8,{label:1,revision:20});
  await db.transaction(async tx=>{
   await tx`UPDATE tracks SET card='{"source":"spotify","private":"forbidden"}' WHERE track_id=${id(8)}`;
   await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${id(8)},'sortfm.features.v1','soundnet','{"private":"artifact"}','{"private":"outcome"}','{}',clock_timestamp()) ON CONFLICT DO NOTHING`;
  });expect(await store.constellationHistory(owner)).toEqual(baseline);
  await repo.upsertSavedTracks([{userId:owner,track:row(9000).track,originalAddedAt:at(),syncedAt:at(),currentStatus:'unliked'}]);await feedback(owner,9000,{split:'holdout',label:null});
  expect(await store.constellationHistory(owner)).toEqual(baseline);
 });
 test('Batch2 sealed skips, replacements and revoked train identities stay excluded from history',async()=>{
  const owner=await seed(80),candidates=experimentDraft().candidates.map(c=>({...c,prediction:{...c.prediction,removalProbability:.5}})),batches=new PostgresCalibrationBatchStore(db),cal=new PostgresCalibrationStore(db);
  const draft={batchId:crypto.randomUUID(),seed:42,modelVersion:prediction.modelVersion,algorithmVersion:BATCH_ALGORITHM,selectedAt:at(),candidates,...selectCalibrationBatch(candidates,42)};
  const batch=await batches.createCalibrationBatch(owner,draft),a=batch.entries.find(e=>e.group==='A')!,b=batch.entries.find(e=>e.group==='B')!;
  await batches.skipCalibrationBatch(owner,{exposureId:a.exposureId,idempotencyKey:createIdempotencyKey()},at());
  const label=await cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:b.trackId,exposureId:b.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'fixture',createdAt:at()});
  await db.transaction(async tx=>{await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${owner}`;await tx`DELETE FROM library_membership WHERE user_id=${owner}`;});
  const projected=await store.constellationHistory(owner);expect(projected.tracks.find(t=>t.id===b.trackId)).toMatchObject({label:'keep',isLiked:false});expect(projected.tracks.some(t=>t.id===a.trackId)).toBe(false);
  const forbidden=await db.transaction(tx=>tx`SELECT track_id FROM calibration_batch_items WHERE user_id=${owner} AND (assignment='sealed_evaluation' OR status<>'labeled')`);
  expect(forbidden.every((r:{track_id:string})=>!projected.tracks.some(t=>t.id===r.track_id))).toBe(true);
  await cal.undoCalibrationLabel({userId:owner,commandId:crypto.randomUUID(),labelId:label.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:at()});
  expect((await store.constellationHistory(owner)).tracks.some(t=>t.id===b.trackId)).toBe(false);
 },60000);
 test('Batch3 reservations and permanent sealed assignments apply before historical membership selection',async()=>{
  const owner=await seed(80),draft=experimentDraft(),batches=new PostgresCalibrationExperimentStore(db),cal=new PostgresCalibrationStore(db),reservation=await batches.reserveCalibrationExperiment(owner,draft);
  expect((await store.constellationHistory(owner)).tracks.map(t=>t.id)).toEqual(Array.from({length:20},(_,i)=>id(i+61)));
  await batches.sealCalibrationExperiment(owner,experimentSeal(draft,reservation));
  const [b]=await db.transaction(tx=>tx`SELECT track_id,exposure_id FROM calibration_batch_items WHERE user_id=${owner} AND sampling_group='B' ORDER BY position LIMIT 1`);
  await cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:b.track_id,exposureId:b.exposure_id,label:1,idempotencyKey:createIdempotencyKey()},requestFingerprint:'fixture',createdAt:at()});
  await db.transaction(async tx=>{await tx`UPDATE saved_tracks SET current_status='archived' WHERE user_id=${owner}`;await tx`DELETE FROM library_membership WHERE user_id=${owner}`;});
  await feedback(owner,1,{label:0,revision:100});
  const result=await store.constellationHistory(owner);expect(result.tracks).toHaveLength(21);expect(result.tracks.find(t=>t.id===b.track_id)).toMatchObject({label:'remove',isLiked:false});expect(result.tracks.some(t=>t.id===id(1))).toBe(false);
 },60000);
 test('active policy bindings suppress historical tracks until closed or expired',async()=>{
  const owner=await seed(3),request=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO policy_selection_intents(user_id,request_id,fingerprint,draft,feedback_revision,membership_revision,created_at,expires_at,status) VALUES(${owner},${request},'fixture','{}',0,1,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','prepared')`;
   for(const n of [1,2])await tx`INSERT INTO policy_exposure_bindings(exposure_id,user_id,request_id,track_id,reserved_at,expires_at) VALUES(${crypto.randomUUID()},${owner},${request},${id(n)},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`;
   await tx`DELETE FROM library_membership WHERE user_id=${owner}`;
  });expect((await store.constellationHistory(owner)).tracks.map(t=>t.id)).toEqual([id(3)]);
  await db.transaction(async tx=>{await tx`UPDATE policy_exposure_bindings SET closed_at=clock_timestamp(),closure_reason='skip' WHERE user_id=${owner} AND track_id=${id(1)}`;await tx`UPDATE policy_exposure_bindings SET expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=${owner} AND track_id=${id(2)}`;});
  expect((await store.constellationHistory(owner)).tracks.map(t=>[t.id,t.isLiked])).toEqual([[id(1),false],[id(2),false],[id(3),false]]);
 });
 test('5000 cap follows permanent history and pilot exclusions and continues across filtered pages',async()=>{
  const owner=await seed(5012);for(let n=1;n<=6;n++)await feedback(owner,n,{split:'holdout',label:null});
  await db.transaction(async tx=>{await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${owner}`;await tx`DELETE FROM library_membership WHERE user_id=${owner}`;await tx`UPDATE tracks SET card='{"source":"spotify","private":"pilot"}' WHERE track_id IN (${id(7)},${id(8)},${id(9)},${id(10)},${id(11)})`;});
  const schema=`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`,manifest={ownerId:owner,pilotSchema:schema,sortedTrackIds:Array.from({length:5},(_,i)=>id(i+7))};
  const policyDb=new Database(url!,schema,{reviewExclusions:{...manifest,sha256:reviewExclusionManifestDigest(manifest)}});
  await db.sql.unsafe(`ALTER SCHEMA "${db.schema}" RENAME TO "${schema}"`);
  try{
   const result=await new PostgresConstellationStore(policyDb).constellationHistory(owner);expect(result.tracks).toHaveLength(5000);expect(result.tracks[0]!.id).toBe(id(12));expect(result.tracks.at(-1)!.id).toBe(id(5011));expect(result.tracks.every(t=>!t.isLiked)).toBe(true);
   await expect(new PostgresConstellationStore(policyDb).constellationHistory('test:other')).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
  }finally{await policyDb.sql.unsafe(`ALTER SCHEMA "${schema}" RENAME TO "${db.schema}"`);await policyDb.close();}
 },60000);
 test('missing synchronization authority, owner or exclusion dependency fails closed',async()=>{
  const owner=await seed();await db.transaction(tx=>tx`DELETE FROM library_state WHERE user_id=${owner}`);
  await expect(store.constellationHistory(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
  await expect(store.constellationHistory('test:missing')).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
  const synced=await seed();await db.transaction(tx=>tx.unsafe('ALTER VIEW unified_feedback RENAME TO history_unavailable_feedback'));
  try{await expect(store.constellationHistory(synced)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});}finally{await db.transaction(tx=>tx.unsafe('ALTER VIEW history_unavailable_feedback RENAME TO unified_feedback'));}
 });
 test('partial policy installation and missing sealed roster identity fail closed',async()=>{
  const owner=await seed(80);
  await db.transaction(tx=>tx.unsafe('ALTER TABLE policy_exposure_bindings RENAME TO history_unavailable_bindings'));
  try{await expect(store.constellationHistory(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});}finally{await db.transaction(tx=>tx.unsafe('ALTER TABLE history_unavailable_bindings RENAME TO policy_exposure_bindings'));}
  const draft=experimentDraft();await new PostgresCalibrationExperimentStore(db).reserveCalibrationExperiment(owner,draft);
  // Corrupt only this unique disposable test schema, never an application schema.
  await db.transaction(async tx=>{
   await tx.unsafe('ALTER TABLE calibration_batch_items DISABLE TRIGGER protect_calibration_batch_item');
   await tx`DELETE FROM calibration_batch_exposures WHERE user_id=${owner} AND batch_item_id=(SELECT batch_item_id FROM calibration_batch_items WHERE user_id=${owner} ORDER BY position LIMIT 1)`;
   await tx`DELETE FROM calibration_batch_items WHERE user_id=${owner} AND position=0`;
   await tx.unsafe('ALTER TABLE calibration_batch_items ENABLE TRIGGER protect_calibration_batch_item');
  });
  await expect(store.constellationHistory(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
 });
});
