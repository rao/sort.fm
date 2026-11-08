import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {Database,json} from '../src/client';
import {migrate} from '../src/migrate';
import {Repository} from '../src/repository';
import {PostgresCalibrationBatchStore} from '../src/calibration-batch';
import {prediction as batchPrediction} from '../../../apps/api/src/calibration/test-fixtures';
import {selectCalibrationBatch,BATCH_ALGORITHM} from '../../../apps/api/src/calibration/batch-selection';
import {reviewExclusionManifestDigest} from '../src/review-exclusions';
import {PostgresA1Store} from '../src/a1-store';
import {PostgresCalibrationStore,calibrationSplit} from '../src/calibration';
import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import type {ExposureInput,CalibrationLabelInput} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL,id=(n:number)=>String(n).padStart(22,'0');
describe.skipIf(!url)('ordinary Teach guards, history and status',()=>{
 let db:Database,repo:Repository,cal:PostgresCalibrationStore,tick=Date.now(),ownerSequence=0;
 const time=()=>new Date(tick+=1000).toISOString();
 beforeAll(async()=>{db=new Database(url!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`);await migrate(db);repo=new Repository(db);cal=new PostgresCalibrationStore(db);},60000);
 afterAll(async()=>{if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);
 async function seed(count=30){const owner=`test:teach:${++ownerSequence}`,ids=Array.from({length:count},(_,i)=>id(i+1));await repo.upsertUser({id:owner,spotifyId:null,displayName:'Synthetic',avatarUrl:null});await repo.upsertSavedTracks(ids.map(trackId=>({userId:owner,track:{...demoTracks[0]!,trackId,source:'spotify' as const,spotifyUri:`spotify:track:${trackId}` as const,isPlayable:true},originalAddedAt:time(),syncedAt:time(),currentStatus:'saved' as const})));await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:ids,sourceTotal:ids.length,observedAt:time()}));return {owner,train:ids.filter(t=>calibrationSplit(owner,t)==='train'),holdout:ids.find(t=>calibrationSplit(owner,t)==='holdout')!};}
 function exposure(owner:string,trackId:string):ExposureInput {const item=createDemoQueue({limit:1,servedAt:time(),exposureId:()=>crypto.randomUUID()}).items[0]!;return {userId:owner,exposure:{...item.exposure,trackId},prediction:item.prediction,features:{featureVersion:'sortfm.features.v1',values:{energy:0.5},provenance:'musicae',permittedForTraining:true}};}
 function label(e:ExposureInput):CalibrationLabelInput{return {userId:e.userId,labelId:crypto.randomUUID(),request:{exposureId:e.exposure.exposureId,trackId:e.exposure.trackId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:time()};}
 async function legacy(owner:string,track:string,split:'train'|'holdout',options:{source?:'review'|'calibration';revoked?:boolean;revision?:number;permitted?:boolean;action?:string;status?:string}={}){const e=exposure(owner,track),v=label(e),{source='calibration',revoked=false,revision=1,permitted=true,action='KEEP',status='COMPLETE'}=options;e.features.permittedForTraining=permitted;await db.transaction(async tx=>{
  await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${e.exposure.exposureId},${owner},${track},${json(e)}::jsonb,${e.exposure.servedAt},${source==='calibration'?'calibration':'review'})`;
  if(source==='calibration')await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revoked,revision,split,created_at,updated_at) VALUES(${v.labelId},${owner},${track},${e.exposure.exposureId},${v.request.idempotencyKey},${v.requestFingerprint},${json(v.request)}::jsonb,0,${revoked?null:0},${revoked},${revision},${split},${v.createdAt},${v.createdAt})`;
  else {await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,result,created_at) VALUES(${v.labelId},${owner},${track},${e.exposure.exposureId},${v.request.idempotencyKey},'fixture',${json({action})}::jsonb,${json({action,status})}::jsonb,${v.createdAt})`;await tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${owner},${v.labelId},${revision},${revoked?null:0},${revoked},${split},${v.createdAt})`;}
  await tx`UPDATE users SET feedback_revision=GREATEST(feedback_revision,${revision}) WHERE id=${owner}`;
 });return v;}
 test('only existing deterministic train identities are served; stale holdout exposures cannot admit labels',async()=>{
  const {owner,train,holdout}=await seed();expect(holdout).toBeDefined();expect((await cal.calibrationCandidates(owner)).eligibleTrackIds).toEqual(train);
  const e=exposure(owner,holdout);await expect(cal.insertCalibrationExposure(e)).rejects.toMatchObject({code:'CALIBRATION_NOT_ELIGIBLE'});
  await db.transaction(tx=>tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${e.exposure.exposureId},${owner},${holdout},${json(e)}::jsonb,${e.exposure.servedAt},'calibration')`);
  await expect(cal.createCalibrationLabel(label(e))).rejects.toMatchObject({code:'CALIBRATION_NOT_ELIGIBLE'});
  expect((await cal.calibrationHistory(owner)).items).toEqual([]);
 });
 test('ever-heldout identity stays excluded after revocation and later train tombstone, at all admission boundaries',async()=>{
  const {owner,train}=await seed(),track=train[0]!;const stale=exposure(owner,track);await cal.insertCalibrationExposure(stale);
  await legacy(owner,track,'holdout',{revoked:true});await legacy(owner,track,'train',{revoked:true,revision:2});
  expect((await cal.calibrationCandidates(owner)).eligibleTrackIds).not.toContain(track);
  await expect(cal.insertCalibrationExposure(exposure(owner,track))).rejects.toMatchObject({code:'CALIBRATION_NOT_ELIGIBLE'});
  await expect(cal.createCalibrationLabel(label(stale))).rejects.toMatchObject({code:'CALIBRATION_NOT_ELIGIBLE'});
  expect((await cal.teachHistory(owner)).items).toEqual([]);expect((await cal.calibrationHistory(owner)).items).toHaveLength(2);
 });
 test('read-only history and status preserve supersession/Undo and never revive prior labels',async()=>{
  const {owner,train}=await seed(),e=exposure(owner,train[0]!);await cal.insertCalibrationExposure(e);const input=label(e),first=await cal.createCalibrationLabel(input);
  expect(await cal.teachingStatus(owner)).toEqual({trainingFeedbackCount:1,feedbackRevision:1,synchronizedFeedbackRevision:null,modelVersion:null});
  await cal.undoCalibrationLabel({userId:owner,labelId:first.labelId,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:time()});
  expect((await cal.teachHistory(owner)).items[0]!.state).toBe('revoked');expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(0);
  expect((await cal.createCalibrationLabel(input)).state).toBe('revoked');
  const fresh=exposure(owner,train[0]!);await cal.insertCalibrationExposure(fresh);const second=await cal.createCalibrationLabel(label(fresh));
  await legacy(owner,train[0]!,'train',{source:'review',revoked:true,revision:4,action:'SKIP'});
  expect((await cal.teachHistory(owner)).items.find(r=>r.labelId===second.labelId)!.state).toBe('superseded');expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(0);
  const before=await db.transaction(tx=>tx`SELECT (SELECT count(*) FROM exposures)::int AS exposures,(SELECT count(*) FROM feedback_sync_jobs)::int AS jobs,(SELECT feedback_revision FROM users WHERE id=${owner}) AS revision`);
  await cal.teachingStatus(owner);await cal.teachHistory(owner);
  expect(await db.transaction(tx=>tx`SELECT (SELECT count(*) FROM exposures)::int AS exposures,(SELECT count(*) FROM feedback_sync_jobs)::int AS jobs,(SELECT feedback_revision FROM users WHERE id=${owner}) AS revision`)).toEqual(before);
 });
 test('counts eligible effective Teach and Review training only, excludes pending and unpermitted rows',async()=>{
  const {owner,train}=await seed();await legacy(owner,train[0]!,'train');await legacy(owner,train[1]!,'train',{source:'review'});
  await legacy(owner,train[2]!,'train',{permitted:false});await legacy(owner,train[3]!,'holdout');
  await legacy(owner,train[4]!,'train',{source:'review',status:'PENDING'});await legacy(owner,train[5]!,'train',{source:'review',action:'SKIP'});
  await legacy(owner,train[6]!,'train',{source:'review',status:'FAILED_TERMINAL'});
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(2);
  await legacy(owner,train[0]!,'train',{source:'review',status:'PENDING',revision:2});
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(1);expect((await cal.teachHistory(owner)).items.some(i=>i.trackId===train[0])).toBe(false);
 });
 test('only genuine model receipts confirm synchronization; no receipt and legacy acknowledgement remain unknown',async()=>{
  const {owner,train}=await seed();await legacy(owner,train[0]!,'train',{revision:5});
  await db.transaction(tx=>tx`INSERT INTO feedback_sync_jobs(user_id,target_revision,acknowledged_revision) VALUES(${owner},5,5)`);
  expect(await cal.teachingStatus(owner)).toEqual({trainingFeedbackCount:1,feedbackRevision:5,synchronizedFeedbackRevision:null,modelVersion:null});
  await db.transaction(tx=>tx`INSERT INTO policy_fit_receipts(user_id,model_version,feedback_revision) VALUES(${owner},'confirmed-model',3)`);
  expect(await cal.teachingStatus(owner)).toEqual({trainingFeedbackCount:1,feedbackRevision:5,synchronizedFeedbackRevision:3,modelVersion:'confirmed-model'});
  await db.transaction(tx=>tx`UPDATE policy_fit_receipts SET feedback_revision=5 WHERE user_id=${owner}`);
  expect((await cal.teachingStatus(owner)).synchronizedFeedbackRevision).toBe(5);
  await db.transaction(tx=>tx`UPDATE policy_fit_receipts SET feedback_revision=6 WHERE user_id=${owner}`);
  await expect(cal.teachingStatus(owner)).rejects.toMatchObject({code:'CALIBRATION_UNAVAILABLE'});
 });
 test('research labels and Undo retain explicit batch path while public Teach hides every assigned identity',async()=>{
  const {owner}=await seed(130),batches=new PostgresCalibrationBatchStore(db);
  const candidates=(await repo.library(owner)).map(r=>{const e=exposure(owner,r.track.trackId);return {track:r.track,features:e.features,prediction:{...batchPrediction,removalProbability:0.5}};});
  const batch=await batches.createCalibrationBatch(owner,{batchId:crypto.randomUUID(),seed:42,modelVersion:candidates[0]!.prediction.modelVersion,algorithmVersion:BATCH_ALGORITHM,selectedAt:time(),candidates,...selectCalibrationBatch(candidates,42)});
  const a=batch.entries.find(e=>e.group==='A')!,b=batch.entries.find(e=>e.group==='B')!;
  const submit=(entry:typeof a)=>cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:entry.trackId,exposureId:entry.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:time()});
  const sealed=await submit(a),trained=await submit(b);
  expect((await cal.calibrationHistory(owner)).items).toHaveLength(2);expect((await cal.teachHistory(owner)).items).toEqual([]);
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(1);
  await cal.undoCalibrationLabel({userId:owner,labelId:sealed.labelId,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'sealed-undo',createdAt:time()});
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(1);
  await cal.undoCalibrationLabel({userId:owner,labelId:trained.labelId,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'train-undo',createdAt:time()});
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(0);
  const skipped=batch.entries.find(e=>e.group==='A'&&e.trackId!==a.trackId)!;
  await batches.skipCalibrationBatch(owner,{exposureId:skipped.exposureId,idempotencyKey:createIdempotencyKey()},time());
  expect((await cal.calibrationCandidates(owner)).eligibleTrackIds.some(id=>batch.entries.some(e=>e.trackId===id))).toBe(false);
  await expect(cal.insertCalibrationExposure(exposure(owner,skipped.trackId))).rejects.toMatchObject({code:'BATCH_TRACK_RESERVED'});
  expect((await cal.teachHistory(owner)).items).toEqual([]);
 },30000);
 test('pilot deny list and active reservations filter histories, counts and ordinary candidates',async()=>{
  const {owner,train}=await seed(),denied=train[0]!,reserved=train[1]!;
  await legacy(owner,denied,'train');await legacy(owner,reserved,'train');
  const input={ownerId:owner,pilotSchema:db.schema,sortedTrackIds:[denied]},pilot=new Database(url!,db.schema,{reviewExclusions:{...input,sha256:reviewExclusionManifestDigest(input)}}),limited=new PostgresCalibrationStore(pilot);
  try{
   expect((await limited.teachHistory(owner)).items.map(i=>i.trackId)).toEqual([reserved]);expect((await limited.teachingStatus(owner)).trainingFeedbackCount).toBe(1);
   await expect(limited.teachHistory('test:other')).rejects.toThrow();
   const request=crypto.randomUUID();await db.transaction(async tx=>{
    await tx`INSERT INTO policy_selection_intents(user_id,request_id,fingerprint,draft,feedback_revision,membership_revision,created_at,expires_at,status) VALUES(${owner},${request},'fixture','{}',1,1,clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour','prepared')`;
    await tx`INSERT INTO policy_exposure_bindings(exposure_id,user_id,request_id,track_id,reserved_at,expires_at) VALUES(${crypto.randomUUID()},${owner},${request},${reserved},clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`;
   });
   expect((await limited.teachHistory(owner)).items).toEqual([]);expect((await limited.teachingStatus(owner)).trainingFeedbackCount).toBe(0);
   expect((await limited.calibrationCandidates(owner)).library.some(r=>[denied,reserved].includes(r.track.trackId))).toBe(false);
   await db.transaction(tx=>tx`UPDATE policy_exposure_bindings SET closed_at=clock_timestamp(),closure_reason='skip' WHERE user_id=${owner}`);
   expect((await limited.teachingStatus(owner)).trainingFeedbackCount).toBe(1);
  }finally{await pilot.close();}
 });
 test('pending review Undo hides effective labels until its revocation settles, then count remains zero',async()=>{
  const {owner,train}=await seed(),track=train[0]!;await legacy(owner,track,'train');const r=await legacy(owner,track,'train',{source:'review',revision:2});
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(1);
  await db.transaction(tx=>tx`INSERT INTO undo_commands(command_id,user_id,decision_id,idempotency_key,request_fingerprint,payload,created_at) VALUES(${crypto.randomUUID()},${owner},${r.labelId},${crypto.randomUUID()},'undo','{}',clock_timestamp())`);
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(0);expect((await cal.teachHistory(owner)).items).toEqual([]);
  await db.transaction(async tx=>{
   await tx`UPDATE undo_commands SET settled_at=clock_timestamp() WHERE user_id=${owner}`;
   await tx`UPDATE review_decisions SET result=jsonb_set(result,'{status}','"UNDONE"') WHERE user_id=${owner} AND decision_id=${r.labelId}`;
   await tx`UPDATE feedback SET label=NULL,revoked=true,revision=3 WHERE user_id=${owner} AND decision_id=${r.labelId}`;
   await tx`UPDATE users SET feedback_revision=3 WHERE id=${owner}`;
  });
  expect((await cal.teachingStatus(owner)).trainingFeedbackCount).toBe(0);expect((await cal.teachHistory(owner)).items[0]!.state).toBe('superseded');
 });
 test('excluded identities cannot impersonate eligible tracks through corrupt card metadata',async()=>{
  const {owner,train}=await seed(),hidden=train[0]!,visible=train[1]!;
  await legacy(owner,hidden,'holdout',{revoked:true});
  const before=await cal.calibrationCandidates(owner);
  const [original]=await db.transaction(tx=>tx`SELECT card FROM tracks WHERE track_id=${hidden}`);
  try{
   await db.transaction(tx=>tx`UPDATE tracks SET card=jsonb_set(card,'{trackId}',${json(visible)}::jsonb) WHERE track_id=${hidden}`);
   expect(await cal.calibrationCandidates(owner)).toEqual(before);
   await db.transaction(tx=>tx`UPDATE tracks SET card='{"private":"forbidden"}' WHERE track_id=${hidden}`);
   expect(await cal.calibrationCandidates(owner)).toEqual(before);
  }finally{await db.transaction(tx=>tx`UPDATE tracks SET card=${json(original.card)}::jsonb WHERE track_id=${hidden}`);}
 });
 test('missing or inconsistent exclusion dependencies fail closed and owners remain isolated',async()=>{
  const {owner,train}=await seed();await legacy(owner,train[0]!,'train');const other=await seed();expect((await cal.teachHistory(other.owner)).items).toEqual([]);expect((await cal.teachingStatus(other.owner)).trainingFeedbackCount).toBe(0);
  await expect(cal.teachingStatus('test:missing')).rejects.toThrow();
  const [migration]=await db.transaction(tx=>tx`DELETE FROM schema_migrations WHERE name='015_calibration_batch2.sql' RETURNING checksum`);
  try{await expect(cal.teachHistory(owner)).rejects.toMatchObject({code:'CALIBRATION_UNAVAILABLE'});await expect(cal.teachingStatus(owner)).rejects.toMatchObject({code:'CALIBRATION_UNAVAILABLE'});await expect(cal.calibrationCandidates(owner)).rejects.toThrow();}finally{await db.transaction(tx=>tx`INSERT INTO schema_migrations(name,checksum) VALUES('015_calibration_batch2.sql',${migration.checksum})`);}
 });
});
