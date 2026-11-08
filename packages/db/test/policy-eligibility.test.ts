import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database,json} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';import {PostgresCalibrationStore} from '../src/calibration';import {readReviewCandidates} from '../src/policy-eligibility';
import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';import {createIdempotencyKey} from '@sortfm/contracts/client';import type {ExposureInput,ReviewResult} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('shared policy eligibility',()=>{
 let db:Database,repo:Repository,cal:PostgresCalibrationStore;let tick=Date.parse('2026-11-07T00:00:00Z');const time=()=>new Date(tick+=1000).toISOString();
 beforeAll(async()=>{db=new Database(url!,`test_policy_elig_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);repo=new Repository(db);cal=new PostgresCalibrationStore(db);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},60000);
 async function fixture(member=true){const userId=`test:policy:${crypto.randomUUID()}`;await repo.upsertUser({id:userId,spotifyId:null,displayName:'Generated fixture',avatarUrl:null});
  const tracks=Array.from({length:6},(_,i)=>({...demoTracks[0]!,trackId:String(i+1).padStart(22,'0'),source:'spotify' as const,spotifyUri:`spotify:track:${String(i+1).padStart(22,'0')}` as const,isPlayable:true}));
  await repo.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:time(),currentStatus:'saved' as const})));
  if(member)await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:tracks.map(t=>t.trackId),sourceTotal:6,observedAt:time()}));
  const exposure=(i:number):ExposureInput=>{const item=createDemoQueue({limit:1,servedAt:time(),exposureId:()=>crypto.randomUUID()}).items[0]!;return {userId,exposure:{...item.exposure,trackId:tracks[i]!.trackId},prediction:item.prediction,features:{featureVersion:'sortfm.features.v1',values:{saved_age_days:3},provenance:'spotify',permittedForTraining:true}};};
  const snapshot=()=>db.transaction(tx=>readReviewCandidates(tx,userId));
  const start=async(i:number,action:'KEEP'|'SKIP'|'UNLIKE'='KEEP')=>{const e=exposure(i);await repo.insertExposure(e);return repo.createDecision({userId,decisionId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:time()});};
  return {userId,tracks,exposure,snapshot,start};
 }
 test('confirmed membership, playability and saved status are required; history never supplies eligible tracks',async()=>{
  const f=await fixture(false);expect((await f.snapshot()).eligibleTrackIds).toEqual([]);
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:f.userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:f.tracks.slice(0,4).map(t=>t.trackId),sourceTotal:4,observedAt:time()}));
  await db.transaction(async tx=>{await tx`UPDATE tracks SET card=jsonb_set(card,'{isPlayable}','false') WHERE track_id=${f.tracks[1]!.trackId}`;await tx`UPDATE saved_tracks SET current_status='kept' WHERE user_id=${f.userId} AND track_id=${f.tracks[2]!.trackId}`;});
  const s=await f.snapshot();expect(s.eligibleTrackIds).toEqual([f.tracks[0]!.trackId,f.tracks[3]!.trackId]);expect(s.library).toHaveLength(4);expect(s.feedbackRevision).toBe(0);expect(s.membershipRevision).toBe(1);
  const other=await fixture();expect((await other.snapshot()).eligibleTrackIds).toHaveLength(6);expect((await f.snapshot()).eligibleTrackIds).not.toContain(f.tracks[2]!.trackId);
 },60000);
 test('pending and strong COMPLETE are excluded; committed restoration and terminal failure permit fresh selection',async()=>{
  const f=await fixture(),pending=await f.start(0,'UNLIKE');expect((await f.snapshot()).eligibleTrackIds).not.toContain(pending.trackId);
  const complete:ReviewResult={...pending,status:'COMPLETE',mutationStep:'UNLIKED',liked:false,canUndo:true,label:1,labelState:'active',feedbackRevision:1,updatedAt:time()};await repo.settleDecision(f.userId,complete,'PENDING','train');expect((await f.snapshot()).eligibleTrackIds).not.toContain(pending.trackId);
  await repo.createUndo({userId:f.userId,commandId:crypto.randomUUID(),decisionId:complete.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:time()});expect((await f.snapshot()).eligibleTrackIds).not.toContain(pending.trackId);
  await repo.settleDecision(f.userId,{...complete,status:'UNDONE',mutationStep:'RESTORED',liked:true,canUndo:false,label:null,labelState:'revoked',feedbackRevision:2,updatedAt:time()},'COMPLETE','train');const restored=await f.snapshot();expect(restored.eligibleTrackIds).toContain(pending.trackId);expect(restored.feedbackRevision).toBe(2);expect(restored.membershipRevision).toBe(3);
  const failed=await f.start(1);await repo.settleDecision(f.userId,{...failed,status:'FAILED_TERMINAL',updatedAt:time()},'PENDING','train');expect((await f.snapshot()).eligibleTrackIds).toContain(failed.trackId);
  const skip=await f.start(2,'SKIP');await repo.settleDecision(f.userId,{...skip,status:'COMPLETE',mutationStep:'NONE',canUndo:true,updatedAt:time()},'PENDING','train');expect((await f.snapshot()).eligibleTrackIds).toContain(skip.trackId);
 },60000);
 test('active calibration labels exclude tracks without becoming cleanup decisions; revoked labels release eligibility',async()=>{
  const f=await fixture(),e=f.exposure(0);await cal.insertCalibrationExposure(e);const label=await cal.createCalibrationLabel({userId:f.userId,labelId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'label',createdAt:time()});
  expect((await f.snapshot()).eligibleTrackIds).not.toContain(e.exposure.trackId);expect(await repo.history(f.userId)).toHaveLength(0);
  await cal.undoCalibrationLabel({userId:f.userId,commandId:crypto.randomUUID(),labelId:label.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:time()});expect((await f.snapshot()).eligibleTrackIds).toContain(e.exposure.trackId);
 },60000);
 test('every permanent Batch2 assignment stays excluded across pending, skipped and revoked states',async()=>{
  const f=await fixture(),batchId=crypto.randomUUID();const exposures=[f.exposure(0),f.exposure(1),f.exposure(2)];for(const e of exposures)await cal.insertCalibrationExposure(e);
  await db.transaction(async tx=>{await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot) VALUES(${batchId},${f.userId},'calibration-batch2-v1',42,'generated-test','generated-test',${time()},'{}'::jsonb)`;
   for(const [i,group] of ['A','B','C'].entries()){const e=exposures[i]!;await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,status,exposure_id) VALUES(${crypto.randomUUID()},${f.userId},${batchId},${e.exposure.trackId},${group},${group==='A'?'sealed_evaluation':'train'},'{}'::jsonb,${json(f.tracks[i])}::jsonb,${time()},${i},${['pending','skipped','revoked'][i]!},${e.exposure.exposureId})`;}
  });
  expect((await f.snapshot()).eligibleTrackIds).toEqual(f.tracks.slice(3).map(t=>t.trackId));expect((await f.snapshot()).library).toHaveLength(6);
  await expect(db.transaction(tx=>tx`DELETE FROM calibration_batch_items WHERE user_id=${f.userId}`)).rejects.toThrow('BATCH_RESERVATION_IMMUTABLE');
 },60000);
});
