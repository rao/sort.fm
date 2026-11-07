import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';
import {FEATURE_VERSION,type ReviewResult} from '@sortfm/contracts';import {createIdempotencyKey} from '@sortfm/contracts/client';import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable feedback reconciliation',()=>{
 let db:Database;let repo:Repository;const userId='test:feedback';const now=new Date().toISOString();const track=demoTracks[0]!;
 async function complete(action:ReviewResult['action'],revision:number){
  const item=createDemoQueue({limit:1,exposureId:()=>crypto.randomUUID()}).items[0]!;
  await repo.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}});
  const pending=await repo.createDecision({userId,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action,exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:now});
  const destructive=action==='UNLIKE'||action==='ARCHIVE';
  const result:ReviewResult={...pending,status:'COMPLETE',mutationStep:destructive?'UNLIKED':'NONE',liked:!destructive,archived:action==='ARCHIVE',canUndo:true,label:action==='SKIP'?null:action==='KEEP'?0:1,labelState:action==='SKIP'?'inactive':'active',feedbackRevision:revision};
  await repo.settleDecision(userId,result,'PENDING','train');return result;
 }
 beforeAll(async()=>{db=new Database(url!,`test_feedback_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);await migrate(db);await repo.upsertUser({id:userId,spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'}]);},30000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30000);
 test('newer feedback survives acknowledgement of an older claimed revision',async()=>{
  await complete('KEEP',1);const first=(await repo.claimFeedbackSync('worker-a',Date.now(),60000))!;expect(first.feedbackRevision).toBe(1);expect(await repo.claimFeedbackSync('worker-b',Date.now(),60000)).toBeNull();
  await complete('UNLIKE',2);expect(await repo.acknowledgeFeedbackSync(userId,first.leaseId,1)).toBe(true);
  const newer=(await repo.claimFeedbackSync('worker-b',Date.now(),60000))!;expect(newer.feedbackRevision).toBe(2);
  expect(await repo.acknowledgeFeedbackSync(userId,first.leaseId,2)).toBe(false);expect(await repo.acknowledgeFeedbackSync(userId,newer.leaseId,99)).toBe(false);
  expect(await repo.acknowledgeFeedbackSync(userId,newer.leaseId,2)).toBe(true);expect(await repo.claimFeedbackSync('worker-a',Date.now(),60000)).toBeNull();
 },30000);
 test('SKIP replacement and Undo enqueue, retries persist, expired leases fence stale acknowledgements',async()=>{
  const skip=await complete('SKIP',3);const first=(await repo.claimFeedbackSync('worker-a',Date.now(),60000))!;expect(first.feedbackRevision).toBe(3);
  await repo.retryFeedbackSync(userId,first.leaseId,Date.now()+60000);expect(await repo.claimFeedbackSync('worker-b',Date.now(),60000)).toBeNull();
  await db.transaction(async tx=>{await tx`UPDATE feedback_sync_jobs SET available_at=now()-interval '1 second' WHERE user_id=${userId}`;});
  const retry=(await repo.claimFeedbackSync('worker-b',Date.now(),60000))!;
  await db.transaction(async tx=>{await tx`UPDATE feedback_sync_jobs SET lease_until=now()-interval '1 second' WHERE user_id=${userId}`;});
  const recovery=(await repo.claimFeedbackSync('worker-c',Date.now(),60000))!;expect(recovery.leaseId).not.toBe(retry.leaseId);expect(await repo.acknowledgeFeedbackSync(userId,retry.leaseId,3)).toBe(false);
  await repo.createUndo({userId,commandId:crypto.randomUUID(),decisionId:skip.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:now});
  const undone:ReviewResult={...skip,status:'UNDONE',canUndo:false,label:null,labelState:'revoked',feedbackRevision:4};await repo.settleDecision(userId,undone,'COMPLETE','train');
  const snapshot=await repo.trainingExamples(userId);expect(snapshot.feedbackRevision).toBe(4);expect(snapshot.examples).toHaveLength(0);
  // A fit may take a newer snapshot than the revision observed at claim time.
  expect(await repo.acknowledgeFeedbackSync(userId,recovery.leaseId,snapshot.feedbackRevision)).toBe(true);
  await repo.settleDecision(userId,undone,'COMPLETE','train');expect(await repo.claimFeedbackSync('worker-d',Date.now(),60000)).toBeNull();
 },30000);
 test('failed settlement rolls back the scheduled reconciliation with its feedback revision',async()=>{
  await db.transaction(async tx=>{
   await tx.unsafe("CREATE FUNCTION reject_feedback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated_feedback_failure'; END $$");
   await tx.unsafe('CREATE TRIGGER reject_feedback BEFORE INSERT OR UPDATE ON feedback FOR EACH ROW EXECUTE FUNCTION reject_feedback()');
  });
  try{
   await expect(complete('KEEP',5)).rejects.toThrow('simulated_feedback_failure');
   expect((await repo.trainingExamples(userId)).feedbackRevision).toBe(4);
   expect(await repo.claimFeedbackSync('worker-e',Date.now(),60000)).toBeNull();
  }finally{await db.transaction(async tx=>{await tx.unsafe('DROP TRIGGER reject_feedback ON feedback');await tx.unsafe('DROP FUNCTION reject_feedback()');});}
 },30000);

});
