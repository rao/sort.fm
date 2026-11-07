import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';
import {FEATURE_VERSION,type ReviewResult} from '@sortfm/contracts';import {createIdempotencyKey} from '@sortfm/contracts/client';import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
// Each cloud integration case performs many sequential SQL round trips.
// Keep a bounded budget for PgBouncer/network variance, not the 5s unit-test default.
const INTEGRATION_TIMEOUT_MS=30_000;
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('settlement invariants',()=>{
 let db:Database;let repo:Repository;let store:PostgresA1Store;const userId='test:settle';const now=new Date().toISOString();const track={...demoTracks[0]!,isPlayable:true};
 async function command(action:ReviewResult['action']){
  const item=createDemoQueue({limit:1,servedAt:new Date(Date.now()+1).toISOString(),exposureId:()=>crypto.randomUUID()}).items[0]!;
  await repo.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}});
  return repo.createDecision({userId,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action,exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:now});
 }
 beforeAll(async()=>{db=new Database(url!,`test_settle_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);store=new PostgresA1Store(db);await migrate(db);await repo.upsertUser({id:userId,spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'}]);await store.transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:[track.trackId],sourceTotal:1,observedAt:now}));},INTEGRATION_TIMEOUT_MS);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},INTEGRATION_TIMEOUT_MS);
 test('unlike and undo update membership and total exactly once',async()=>{
  const pending=await command('UNLIKE');const complete:ReviewResult={...pending,status:'COMPLETE',mutationStep:'UNLIKED',liked:false,archived:false,canUndo:true,label:1,labelState:'active',feedbackRevision:1};
  await repo.settleDecision(userId,complete,'PENDING','holdout');await repo.settleDecision(userId,complete,'PENDING','holdout');expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(0);expect(await repo.library(userId)).toHaveLength(0);
  await repo.createUndo({userId,commandId:crypto.randomUUID(),decisionId:pending.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:now});
  const undone:ReviewResult={...complete,status:'UNDONE',mutationStep:'RESTORED',liked:true,canUndo:false,label:null,labelState:'revoked',feedbackRevision:2};await repo.settleDecision(userId,undone,'COMPLETE','holdout');await repo.settleDecision(userId,undone,'COMPLETE','holdout');
  expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(1);expect(await repo.library(userId)).toHaveLength(1);
 },INTEGRATION_TIMEOUT_MS);
 test('pending replacement keeps effective training feedback until an atomic revised settlement',async()=>{
  const keep=await command('KEEP');await repo.settleDecision(userId,{...keep,status:'COMPLETE',mutationStep:'NONE',liked:true,archived:false,canUndo:true,label:0,labelState:'active',feedbackRevision:3},'PENDING','train');
  const skip=await command('SKIP');let data=await repo.trainingExamples(userId);expect(data.feedbackRevision).toBe(3);expect(data.examples).toHaveLength(1);expect(data.examples[0]!.split).toBe('holdout');
  await repo.settleDecision(userId,{...skip,status:'COMPLETE',mutationStep:'NONE',liked:true,archived:false,canUndo:true,feedbackRevision:4},'PENDING','train');
  data=await repo.trainingExamples(userId);expect(data.feedbackRevision).toBe(4);expect(data.examples).toHaveLength(0);
 },INTEGRATION_TIMEOUT_MS);
});
