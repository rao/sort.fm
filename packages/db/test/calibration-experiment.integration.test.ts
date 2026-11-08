import {policyFixture} from './policy-fixtures';
import {PostgresPolicyStore} from '../src/policy-store';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {CALIBRATION_BATCH3_EXPERIMENT as experiment,type CalibrationExperimentDraft,type ExposureInput} from '@sortfm/contracts';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';import {PostgresCalibrationStore} from '../src/calibration';import {PostgresCalibrationBatchStore} from '../src/calibration-batch';import {PostgresCalibrationExperimentStore} from '../src/calibration-experiment';import {experimentDraft,experimentSeal,hash} from './calibration-experiment-fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Batch3 durable reserve and seal',()=>{
 let db:Database,repo:Repository,store:any,cal:PostgresCalibrationStore;let tick=Date.now();const at=()=>new Date(tick=Math.max(tick+10,Date.now()+10)).toISOString();
 beforeAll(async()=>{db=new Database(url!,`test_batch3_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);store=new PostgresCalibrationExperimentStore(db);cal=new PostgresCalibrationStore(db);},60000);
 afterAll(async()=>{if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);
 async function fixture(){const owner=`test:${crypto.randomUUID()}`,draft=experimentDraft();await repo.upsertUser({id:owner,spotifyId:null,displayName:'Synthetic',avatarUrl:null});await repo.upsertSavedTracks(draft.candidates.map(c=>({userId:owner,track:c.track,originalAddedAt:c.track.originalAddedAt,syncedAt:at(),currentStatus:'saved' as const})));await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:draft.candidates.map(c=>c.track.trackId),sourceTotal:80,observedAt:at()}));return {owner,draft};}
 const label=(owner:string,e:{trackId:string;exposureId:string})=>cal.createCalibrationLabel({userId:owner,labelId:crypto.randomUUID(),request:{trackId:e.trackId,exposureId:e.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:at()});
 test('atomic concurrent reservation returns immutable receipt and public counts only; all guessed admission paths reject',async()=>{
  const {owner,draft}=await fixture();const [a,b]=await Promise.all([store.reserveCalibrationExperiment(owner,draft),store.reserveCalibrationExperiment(owner,draft)]);expect(a).toEqual(b);
  const publicView=await store.calibrationExperiment(owner,experiment,at());expect(Object.keys(publicView).sort()).toEqual(['batchId','experiment','groups','phase','reservedAt','target']);expect(publicView.phase).toBe('reserved');
  const snap=await store.calibrationExperimentSnapshot(owner,experiment);expect(snap.draft).toEqual(draft);expect(snap.seal).toBeNull();
  const [e]=await db.transaction(tx=>tx`SELECT track_id AS "trackId",exposure_id AS "exposureId" FROM calibration_batch_items WHERE user_id=${owner} ORDER BY position`);
  await expect(label(owner,e)).rejects.toMatchObject({code:'BATCH_NOT_READY'});
  await expect(repo.getExposure(owner,e.exposureId)).rejects.toMatchObject({code:'BATCH_NOT_READY'});
  await expect(store.skipCalibrationExperiment(owner,experiment,{exposureId:e.exposureId,idempotencyKey:createIdempotencyKey()},at())).rejects.toMatchObject({code:'BATCH_NOT_READY'});
  await expect(new PostgresCalibrationBatchStore(db).skipCalibrationBatch(owner,{exposureId:e.exposureId,idempotencyKey:createIdempotencyKey()},at())).rejects.toThrow();
  await expect(db.transaction(tx=>tx`UPDATE calibration_batch_items SET status='revoked' WHERE user_id=${owner}`)).rejects.toThrow('BATCH_NOT_READY');
  await expect(db.transaction(tx=>tx`UPDATE calibration_batches SET snapshot='{}'::jsonb WHERE user_id=${owner}`)).rejects.toThrow('BATCH_SNAPSHOT_IMMUTABLE');
  await expect(store.reserveCalibrationExperiment(owner,{...draft,algorithmVersion:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect(await store.calibrationExperimentSnapshot('test:foreign',experiment)).toBeNull();
  // Synthetic administrative backfill bypasses application admission: even a
  // revoked/null historical event must prevent this previously reserved seal.
  const decisionId=crypto.randomUUID();await db.transaction(async tx=>{
   await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,created_at) VALUES(${decisionId},${owner},${e.trackId},${e.exposureId},${crypto.randomUUID()},'synthetic-backfill','{}'::jsonb,clock_timestamp())`;
   await tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${owner},${decisionId},1,NULL,true,'holdout',clock_timestamp())`;
  });
  await expect(store.sealCalibrationExperiment(owner,experimentSeal(draft,a))).rejects.toMatchObject({code:'BATCH_FEEDBACK_EXISTS'});
  expect((await store.calibrationExperiment(owner,experiment,at())).phase).toBe('reserved');

 },60000);
 test('seal verifies exact features/order/artists, clocks, permanent A and ordered B replacement; replay survives labels',async()=>{
  const {owner,draft}=await fixture(),reservation=await store.reserveCalibrationExperiment(owner,draft),input=experimentSeal(draft,reservation);
  const wrong=structuredClone(input);wrong.queryGroups[wrong.evaluationCandidates[0]!.trackId]='wrong';await expect(store.sealCalibrationExperiment(owner,wrong)).rejects.toThrow('BATCH_SEAL_MISMATCH');
  const features=structuredClone(input);features.evaluationCandidates[0]!.features.values={energy:.123};await expect(store.sealCalibrationExperiment(owner,features)).rejects.toThrow('BATCH_SEAL_MISMATCH');
  await expect(store.sealCalibrationExperiment(owner,{...input,externalSealedAt:'2099-01-01T00:00:00.000Z'})).rejects.toThrow('BATCH_SEAL_CHRONOLOGY');
  const receipt=await store.sealCalibrationExperiment(owner,input);expect(Date.parse(receipt.checkedAt)).toBeLessThan(Date.parse(receipt.readyAt));expect(receipt.everFeedbackCount).toBe(0);
  let ready=await store.calibrationExperiment(owner,experiment,at());expect(ready.phase).toBe('ready');expect(ready.entries).toHaveLength(60);
  const a=ready.entries[0],b=ready.entries[40];const l=await label(owner,b);expect((await repo.trainingExamples(owner)).examples.map(e=>e.trackId)).toEqual([b.trackId]);expect(await store.sealCalibrationExperiment(owner,input)).toEqual(receipt);
  await expect(store.sealCalibrationExperiment(owner,{...input,artifacts:{...input.artifacts,predictionsSha256:'e'.repeat(64)}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  await cal.undoCalibrationLabel({userId:owner,commandId:crypto.randomUUID(),labelId:l.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:at()});
  ready=await store.calibrationExperiment(owner,experiment,at());const renewed=ready.entries.find((e:any)=>e.batchItemId===b.batchItemId);expect(renewed.exposureId).not.toBe(b.exposureId);
  const skip={exposureId:a.exposureId,idempotencyKey:createIdempotencyKey()};const skipped=await store.skipCalibrationExperiment(owner,experiment,skip,at());expect(skipped.entries).toHaveLength(60);expect(skipped.groups[0].pending).toBe(39);expect(await store.skipCalibrationExperiment(owner,experiment,skip,at())).toEqual(skipped);
  ready=await store.skipCalibrationExperiment(owner,experiment,{exposureId:renewed.exposureId,idempotencyKey:createIdempotencyKey()},at());const replacement=ready.entries.find((e:any)=>e.replacementFor===b.batchItemId);expect(replacement.trackId).toBe(draft.replacementPool[20]!.trackId);expect(ready.entries).toHaveLength(61);
  const a2=ready.entries.find((e:any)=>e.group==='A'&&e.status==='pending');await label(owner,a2);expect((await repo.trainingExamples(owner)).examples.some(e=>e.trackId===a2.trackId)).toBe(false);
  expect((await store.calibrationExperimentSnapshot(owner,experiment)).draft).toEqual(draft);
 },60000);
 test('unlabeled calibration exposure changes eligibility without owner revision and stale reservation is atomic',async()=>{
  const {owner,draft}=await fixture(),snapshot=await store.calibrationExperimentCandidates(owner,draft.exclusionLedger);expect(snapshot.eligibleTrackIds).toHaveLength(80);expect(snapshot.ownerRevision).toEqual(draft.ownerRevision);
  const c=draft.candidates[79]!,e:ExposureInput={userId:owner,features:c.features,prediction:c.prediction,exposure:{exposureId:crypto.randomUUID(),trackId:c.track.trackId,policy:'balanced',selectionMethod:'deterministic_baseline',policyVersion:'test',explorationCoefficient:0,propensityEstimate:null,modelVersion:c.prediction.modelVersion,featureVersion:c.features.featureVersion,removalScore:c.prediction.removalProbability,heuristicScore:null,uncertainty:c.prediction.uncertainty,position:0,servedAt:at()}};await cal.insertCalibrationExposure(e);
  const after=await store.calibrationExperimentCandidates(owner,draft.exclusionLedger);expect(after.ownerRevision).toEqual(snapshot.ownerRevision);expect(after.eligibleTrackIds).toHaveLength(79);
  await expect(store.reserveCalibrationExperiment(owner,draft)).rejects.toThrow('BATCH_CANDIDATES_CHANGED');expect(await store.calibrationExperiment(owner,experiment,at())).toBeNull();
  const excluded={source:'external',sortedTrackIds:[draft.candidates[0]!.track.trackId],sortedIdsSha256:hash([draft.candidates[0]!.track.trackId])};expect((await store.calibrationExperimentCandidates(owner,excluded)).eligibleTrackIds).toHaveLength(78);
 },60000);
 test('strict history includes revoked labels and pending review; adaptive unchosen pools remain eligible',async()=>{
  const f=await policyFixture(db),policy=new PostgresPolicyStore(db),ledger=experimentDraft().exclusionLedger;
  const adaptive=f.adaptive();await policy.prepareSelection(adaptive);
  expect((await store.calibrationExperimentCandidates(f.userId,ledger)).eligibleTrackIds).toHaveLength(5);
  if(adaptive.draft.kind!=='adaptive')throw Error('BAD_FIXTURE');await policy.releaseSelection({userId:f.userId,requestId:adaptive.requestId,releaseId:crypto.randomUUID(),exposureIds:[adaptive.draft.request.exposureId],reason:'abandoned'});
  const c1=f.c1();await policy.prepareSelection(c1);
  expect((await store.calibrationExperimentCandidates(f.userId,ledger)).eligibleTrackIds).toEqual(f.tracks.slice(2).map(t=>t.trackId));
  const e=f.item(2);await f.repo.insertExposure(e);await f.repo.createDecision({userId:f.userId,decisionId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP',idempotencyKey:createIdempotencyKey()},requestFingerprint:'pending',createdAt:at()});
  const c=f.item(3);await cal.insertCalibrationExposure(c);const l=await label(f.userId,{trackId:c.exposure.trackId,exposureId:c.exposure.exposureId});
  await cal.undoCalibrationLabel({userId:f.userId,commandId:crypto.randomUUID(),labelId:l.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:at()});
  expect((await store.calibrationExperimentCandidates(f.userId,ledger)).eligibleTrackIds).toEqual([f.tracks[4]!.trackId]);
 },60000);
});
