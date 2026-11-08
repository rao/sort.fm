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
const features={featureVersion:'sortfm.features.v1',provenance:'musicae',permittedForTraining:true,values:{energy:0,happiness:null,tempo_bpm:125,loudness_db:-7,saved_age_days:999,kept_centroid_distance:3}};
describe.skipIf(!url)('read-only constellation PostgreSQL projection',()=>{
 let db:Database,repo:Repository,store:PostgresConstellationStore;
 beforeAll(async()=>{db=new Database(url!,`test_constellation_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);store=new PostgresConstellationStore(db);},60000);
 afterAll(async()=>{if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);
 async function seed(n=8){const owner=`test:graph:${crypto.randomUUID()}`;await repo.upsertUser({id:owner,spotifyId:null,displayName:'Synthetic fixture owner',avatarUrl:null});await repo.upsertSavedTracks(Array.from({length:n},(_,i)=>({userId:owner,track:row(i+1).track,originalAddedAt:at(),syncedAt:at(),currentStatus:'saved' as const})));await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:Array.from({length:n},(_,i)=>id(i+1)),sourceTotal:n,observedAt:at()}));return owner;}
 async function feedback(owner:string,n:number,split='train',label:0|1|null=0,revision=1,permitted=true){
  const decision=crypto.randomUUID(),exposure=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at) VALUES(${exposure},${owner},${id(n)},${json({features:{...features,permittedForTraining:permitted}})}::jsonb,clock_timestamp())`;
   await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,result,created_at) VALUES(${decision},${owner},${id(n)},${exposure},${crypto.randomUUID()},'fixture',${json({action:label===1?'UNLIKE':'KEEP'})}::jsonb,${json({status:'COMPLETE',action:label===1?'UNLIKE':'KEEP'})}::jsonb,clock_timestamp())`;
   await tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${owner},${decision},${revision},${label},${label===null},${split},clock_timestamp())`;
  });return {decision,exposure};
 }
 test('real owner metadata, explicit eligible labels, observed missingness and no database writes',async()=>{
  const owner=await seed(),other=await seed(2);
  await feedback(owner,1,'train',0);await feedback(owner,2,'train',1);await feedback(owner,3,'train',0);await feedback(owner,3,'train',null,2);await feedback(owner,4,'train',1,1,false);
  await db.transaction(async tx=>{
   await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${id(1)},'sortfm.features.v1','soundnet','{}',${json({...features,provenance:'soundnet'})}::jsonb,'{}',clock_timestamp()) ON CONFLICT DO NOTHING`;
   await tx`UPDATE saved_tracks SET current_status='kept' WHERE user_id=${owner} AND track_id=${id(1)}`;
   await tx`UPDATE tracks SET card=jsonb_set(jsonb_set(card,'{title}',${json('a'.repeat(210))}::jsonb),'{imageUrl}','"http://example.invalid/cover"') WHERE track_id=${id(1)}`;
  });
  const counts=()=>db.transaction(async tx=>(await tx`SELECT (SELECT count(*) FROM exposures) AS exposures,(SELECT count(*) FROM feedback) AS feedback,(SELECT count(*) FROM interaction_events) AS events,(SELECT count(*) FROM soundnet_jobs) AS jobs,(SELECT count(*) FROM policy_selection_intents) AS intents`)[0]);
  const before=await counts(),result=await store.constellation(owner);expect(await counts()).toEqual(before);expect(result.userId).toBe(owner);expect(result.tracks).toHaveLength(8);
  expect(result.tracks.slice(0,4).map(t=>t.label)).toEqual(['keep','remove',null,null]);expect(result.tracks[0]!.audio).toEqual({energy:0,happiness:null,tempo_bpm:125,loudness_db:-7});expect(result.tracks[0]!.title).toHaveLength(200);expect(result.tracks[0]!.imageUrl).toBeNull();expect(result.tracks[1]!.audio).toEqual({});
  expect((await store.constellation(other)).tracks.map(t=>t.label)).toEqual([null,null]);
  await expect(store.constellation('test:missing')).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
 });
 test('full historical monitoring exclusions win over newer training labels and pending work',async()=>{
  const owner=await seed();await feedback(owner,1,'holdout',null);await feedback(owner,1,'train',0,2);
  const pending=await feedback(owner,2),undo=await feedback(owner,3);
  await db.transaction(async tx=>{
   await tx`UPDATE review_decisions SET result='{"status":"FAILED_RETRYABLE"}' WHERE decision_id=${pending.decision}`;
   await tx`INSERT INTO undo_commands(command_id,user_id,decision_id,idempotency_key,request_fingerprint,payload,created_at) VALUES(${crypto.randomUUID()},${owner},${undo.decision},${crypto.randomUUID()},'fixture','{}',clock_timestamp())`;
   await tx`DELETE FROM library_membership WHERE user_id=${owner} AND track_id=${id(4)}`;
   await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${owner} AND track_id=${id(5)}`;
  });
  expect((await store.constellation(owner)).tracks.map(t=>t.id)).toEqual([id(6),id(7),id(8)]);
 });
 test('forbidden metadata, audio and outcomes cannot influence the projection',async()=>{
  const owner=await seed();await feedback(owner,8,'holdout',null);const baseline=await store.constellation(owner);
  await db.transaction(async tx=>{
   await tx`UPDATE tracks SET card='{"private":"forbidden"}' WHERE track_id=${id(8)}`;
   await tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${id(8)},'sortfm.features.v1','soundnet','{"private":"artifact"}','{"private":"outcome"}','{}',clock_timestamp()) ON CONFLICT DO NOTHING`;
  });await feedback(owner,8,'train',1,20);
  expect(await store.constellation(owner)).toEqual(baseline);
  // A newly owned forbidden identity must not change any existing returned node.
  const track=row(9000).track;await repo.upsertSavedTracks([{userId:owner,track,originalAddedAt:at(),syncedAt:at(),currentStatus:'saved'}]);await feedback(owner,9000,'holdout',null);
  await db.transaction(tx=>tx`INSERT INTO library_membership(user_id,track_id,job_id,pass) VALUES(${owner},${track.trackId},${crypto.randomUUID()},0)`);
  expect(await store.constellation(owner)).toEqual(baseline);
 });
 test('Batch2 sealed skips/replacements/revocations stay excluded while settled train is retained',async()=>{
  const owner=await seed(80),candidates=experimentDraft().candidates.map(c=>({...c,prediction:{...c.prediction,removalProbability:.5}})),batches=new PostgresCalibrationBatchStore(db),cal=new PostgresCalibrationStore(db);
  const draft={batchId:crypto.randomUUID(),seed:42,modelVersion:prediction.modelVersion,algorithmVersion:BATCH_ALGORITHM,selectedAt:at(),candidates,...selectCalibrationBatch(candidates,42)};
  const batch=await batches.createCalibrationBatch(owner,draft),a=batch.entries.find(e=>e.group==='A')!,b=batch.entries.find(e=>e.group==='B')!;
  const changed=await batches.skipCalibrationBatch(owner,{exposureId:a.exposureId,idempotencyKey:createIdempotencyKey()},at());
  const label=await cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:b.trackId,exposureId:b.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'fixture',createdAt:at()});
  const result=await store.constellation(owner);expect(result.tracks.find(t=>t.id===b.trackId)?.label).toBe('keep');expect(changed.entries.filter(e=>e.group==='A').every(e=>!result.tracks.some(t=>t.id===e.trackId))).toBe(true);
  await cal.undoCalibrationLabel({userId:owner,commandId:crypto.randomUUID(),labelId:label.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:at()});expect((await store.constellation(owner)).tracks.some(t=>t.id===b.trackId)).toBe(false);
 },60000);
 test('Batch3 reserved/ready boundaries retain permanent A and only settled train B',async()=>{
  const owner=await seed(80),draft=experimentDraft(),batches=new PostgresCalibrationExperimentStore(db),cal=new PostgresCalibrationStore(db),reservation=await batches.reserveCalibrationExperiment(owner,draft);
  const reserved=await store.constellation(owner);expect(reserved.tracks.map(t=>t.id)).toEqual(draft.candidates.slice(60).map(c=>c.track.trackId));
  await batches.sealCalibrationExperiment(owner,experimentSeal(draft,reservation));
  const [b]=await db.transaction(tx=>tx`SELECT track_id,exposure_id FROM calibration_batch_items WHERE user_id=${owner} AND sampling_group='B' ORDER BY position LIMIT 1`);
  await cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:b.track_id,exposureId:b.exposure_id,label:1,idempotencyKey:createIdempotencyKey()},requestFingerprint:'fixture',createdAt:at()});
  const result=await store.constellation(owner);expect(result.tracks.find(t=>t.id===b.track_id)?.label).toBe('remove');expect(result.tracks).toHaveLength(21);
  await db.transaction(async tx=>{await tx.unsafe('ALTER TABLE calibration_experiments DISABLE TRIGGER protect_calibration_experiment');await tx`DELETE FROM calibration_experiments WHERE user_id=${owner}`;});
  await expect(store.constellation(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
 },60000);
 test('limit applies after historical and immutable pilot exclusions',async()=>{
  const owner=await seed(5012);for(let n=1;n<=6;n++)await feedback(owner,n,'holdout',null);
  const schema=`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`,manifest={ownerId:owner,pilotSchema:schema,sortedTrackIds:Array.from({length:5},(_,i)=>id(i+7))};
  // The synthetic schema is renamed only for this final isolated policy check.
  const policyDb=new Database(url!,schema,{reviewExclusions:{...manifest,sha256:reviewExclusionManifestDigest(manifest)}});
  await db.sql.unsafe(`ALTER SCHEMA "${db.schema}" RENAME TO "${schema}"`);
  try{const result=await new PostgresConstellationStore(policyDb).constellation(owner);expect(result.tracks).toHaveLength(5000);expect(result.tracks[0]!.id).toBe(id(12));expect(result.tracks.at(-1)!.id).toBe(id(5011));await expect(new PostgresConstellationStore(policyDb).constellation('test:other')).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});}
  finally{await policyDb.close();await db.sql.unsafe(`ALTER SCHEMA "${schema}" RENAME TO "${db.schema}"`);}
 },60000);
 test('active policy bindings are excluded and partial policy storage fails closed',async()=>{
  const owner=await seed(),request=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO policy_selection_intents(user_id,request_id,fingerprint,draft,feedback_revision,membership_revision,expires_at,status) VALUES(${owner},${request},'fixture','{}',0,1,clock_timestamp()+interval '5 minutes','prepared')`;
   await tx`INSERT INTO policy_exposure_bindings(exposure_id,user_id,request_id,track_id,reserved_at,expires_at) VALUES(${crypto.randomUUID()},${owner},${request},${id(8)},clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
  });expect((await store.constellation(owner)).tracks.some(t=>t.id===id(8))).toBe(false);
  await db.transaction(tx=>tx.unsafe('ALTER TABLE policy_owner_state RENAME TO unavailable_owner_state'));
  try{await expect(store.constellation(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});}finally{await db.transaction(tx=>tx.unsafe('ALTER TABLE unavailable_owner_state RENAME TO policy_owner_state'));}
 });
 test('only successful real provider observations escape, without synthetic or quarantined values',async()=>{
  const owner=await seed(16),request=crypto.randomUUID();
  await db.transaction(async tx=>{
   await tx`INSERT INTO musicae_requests(request_id,expected_tracks,state) VALUES(${request},'[]','complete')`;
   for(const [n,quality,normalized] of [[12,'success',features],[13,'quarantined',features],[14,'success',{...features,provenance:'synthetic'}],[15,'success',{...features,values:{energy:10}}]] as const){
    await tx`INSERT INTO musicae_features(track_id,feature_version,quality,raw,normalized,data_quality,request_id,fetched_at) VALUES(${id(n)},'sortfm.features.v1',${quality},'{}',${json(normalized)}::jsonb,'{}',${request},clock_timestamp())`;
   }
  });
  const projected=await store.constellation(owner);expect(projected.tracks.find(t=>t.id===id(12))!.audio).toEqual({energy:0,happiness:null,tempo_bpm:125,loudness_db:-7});
  for(const n of [13,14,15,16])expect(projected.tracks.find(t=>t.id===id(n))!.audio).toEqual({});
 });
 test('missing initial sealed assignment is detected independently of effective labels',async()=>{
  const owner=await seed(80),draft=experimentDraft(),batches=new PostgresCalibrationExperimentStore(db);await batches.reserveCalibrationExperiment(owner,draft);
  // Administrator-only corruption simulation in this disposable schema.
  await db.transaction(async tx=>{
   await tx.unsafe('ALTER TABLE calibration_batch_items DISABLE TRIGGER protect_calibration_batch_item');
   await tx`DELETE FROM calibration_batch_exposures WHERE user_id=${owner} AND batch_item_id=(SELECT batch_item_id FROM calibration_batch_items WHERE user_id=${owner} ORDER BY position LIMIT 1)`;
   await tx`DELETE FROM calibration_batch_items WHERE user_id=${owner} AND position=0`;
   await tx.unsafe('ALTER TABLE calibration_batch_items ENABLE TRIGGER protect_calibration_batch_item');
  });await expect(store.constellation(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});
 });
 test('missing required exclusion view fails closed',async()=>{
  const owner=await seed();await db.transaction(tx=>tx.unsafe('ALTER VIEW unified_feedback RENAME TO unavailable_feedback'));
  try{await expect(store.constellation(owner)).rejects.toMatchObject({code:'CONSTELLATION_UNAVAILABLE'});}finally{await db.transaction(tx=>tx.unsafe('ALTER VIEW unavailable_feedback RENAME TO unified_feedback'));}
 });
});
