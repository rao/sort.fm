import {test,expect,describe,beforeAll,beforeEach,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';
import {FEATURE_VERSION,type ReviewResult} from '@sortfm/contracts';import {createIdempotencyKey} from '@sortfm/contracts/client';import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('import publication fences concurrent review membership',()=>{
 let db:Database;let repo:Repository;let store:PostgresA1Store;const track={...demoTracks[0]!,isPlayable:true};
 beforeAll(async()=>{db=new Database(url!,`test_import_fence_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);store=new PostgresA1Store(db);await migrate(db);},30000);
 beforeEach(async()=>{await db.transaction(async tx=>{await tx`TRUNCATE review_work_leases,review_work`;});});
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30000);
 async function publish(userId:string,expectedMembershipRevision:number,present:boolean){const input={userId,expectedMembershipRevision,jobId:crypto.randomUUID(),pass:0,trackIds:present?[track.trackId]:[],sourceTotal:present?1:0,observedAt:new Date().toISOString()};await store.transaction(tx=>tx.completeImportMembership(input));}
 async function setup(publishInitially=true){const userId=`test:${crypto.randomUUID()}`;const now=new Date().toISOString();await repo.upsertUser({id:userId,spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'}]);if(publishInitially)await publish(userId,0,true);
  const item=createDemoQueue({limit:1,servedAt:now,exposureId:()=>crypto.randomUUID()}).items[0]!;await repo.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}});
  return {userId,input:{userId,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action:'UNLIKE' as const,exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:'unlike',createdAt:now}};
 }
 const complete=(r:ReviewResult):ReviewResult=>({...r,status:'COMPLETE',mutationStep:'UNLIKED',liked:false,archived:false,canUndo:true,label:1,labelState:'active',feedbackRevision:1});
 test('scan captured before Unlike cannot restore removed membership or total',async()=>{
  const {userId,input}=await setup();const pending=await repo.createDecision(input);const result=complete(pending);await repo.settleDecision(userId,result,'PENDING','train');
  await expect(publish(userId,1,true)).rejects.toThrow('IMPORT_MEMBERSHIP_CHANGED');expect(await repo.library(userId)).toHaveLength(0);expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(0);
  // Identical settlement retry must not increment the revision again.
  await repo.settleDecision(userId,result,'PENDING','train');await publish(userId,2,false);expect(await repo.library(userId)).toHaveLength(0);
 },30000);
 test('scan captured before Undo cannot erase restored membership',async()=>{
  const {userId,input}=await setup();const pending=await repo.createDecision(input);const result=complete(pending);await repo.settleDecision(userId,result,'PENDING','train');
  await repo.createUndo({userId,commandId:crypto.randomUUID(),decisionId:pending.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()});
  await expect(publish(userId,2,false)).rejects.toThrow('MEMBERSHIP_MUTATION_PENDING');
  const undone:ReviewResult={...result,status:'UNDONE',mutationStep:'RESTORED',liked:true,canUndo:false,label:null,labelState:'revoked',feedbackRevision:2};await repo.settleDecision(userId,undone,'COMPLETE','train');
  await expect(publish(userId,2,false)).rejects.toThrow('IMPORT_MEMBERSHIP_CHANGED');expect(await repo.library(userId)).toHaveLength(1);expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(1);
  await publish(userId,3,true);expect(await repo.library(userId)).toHaveLength(1);
 },30000);
 test('publication and destructive command creation serialize, and failed publication rolls back revision',async()=>{
  const {userId,input}=await setup();
  const [publication,creation]=await Promise.allSettled([publish(userId,1,true),repo.createDecision(input)]);
  expect(creation.status).toBe('fulfilled');if(creation.status!=='fulfilled')throw creation.reason;
  if(publication.status==='rejected')expect(publication.reason.message).toBe('MEMBERSHIP_MUTATION_PENDING');
  await repo.settleDecision(userId,complete(creation.value),'PENDING','train');expect(await repo.library(userId)).toHaveLength(0);expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(0);
  const revision=await store.transaction(tx=>tx.getMembershipRevision(userId));expect(revision).toBe(publication.status==='fulfilled'?3:2);
  // Missing track causes a FK failure after deleting existing membership. The whole transaction, including its revision, must roll back.
  const invalid={userId,expectedMembershipRevision:revision,jobId:crypto.randomUUID(),pass:0,trackIds:['not-a-saved-track'],sourceTotal:1,observedAt:new Date().toISOString()};
  await expect(store.transaction(tx=>tx.completeImportMembership(invalid))).rejects.toThrow();expect(await store.transaction(tx=>tx.getMembershipRevision(userId))).toBe(revision);expect(await repo.library(userId)).toHaveLength(0);
 },30000);
 test('a serializable import snapshot taken before command creation still sees pending work after owner-lock acquisition',async()=>{
  const {userId,input}=await setup();let release!:()=>void,ready!:()=>void;const readyPromise=new Promise<void>(r=>{ready=r;}),barrier=new Promise<void>(r=>{release=r;});
  const publishing=store.transaction(async tx=>{await tx.getSummary(userId);ready();await barrier;await tx.completeImportMembership({userId,expectedMembershipRevision:1,jobId:crypto.randomUUID(),pass:0,trackIds:[],sourceTotal:0,observedAt:new Date().toISOString()});});
  const outcome=publishing.then(()=>null,error=>error);
  await readyPromise;await repo.createDecision(input);release();
  expect((await outcome)?.message).toBe('MEMBERSHIP_MUTATION_PENDING');expect(await repo.library(userId)).toHaveLength(1);
 },30000);
 test('an old serializable snapshot cannot miss a newly reserved destructive Undo',async()=>{
  const {userId,input}=await setup();const pending=await repo.createDecision(input);await repo.settleDecision(userId,complete(pending),'PENDING','train');
  let release!:()=>void,ready!:()=>void;const readyPromise=new Promise<void>(r=>{ready=r;}),barrier=new Promise<void>(r=>{release=r;});
  const outcome=store.transaction(async tx=>{await tx.getSummary(userId);ready();await barrier;await tx.completeImportMembership({userId,expectedMembershipRevision:2,jobId:crypto.randomUUID(),pass:0,trackIds:[],sourceTotal:0,observedAt:new Date().toISOString()});}).then(()=>null,error=>error);
  await readyPromise;await repo.createUndo({userId,commandId:crypto.randomUUID(),decisionId:pending.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()});release();
  expect((await outcome)?.message).toBe('MEMBERSHIP_MUTATION_PENDING');expect(await store.transaction(tx=>tx.getMembershipRevision(userId))).toBe(2);
 },30000);
 test('partial initial imports are invalidated even before library_state exists',async()=>{
  const {userId,input}=await setup(false);expect(await store.transaction(tx=>tx.getMembershipRevision(userId))).toBe(0);
  const pending=await repo.createDecision(input);await repo.settleDecision(userId,complete(pending),'PENDING','train');
  expect(await store.transaction(tx=>tx.getMembershipRevision(userId))).toBe(1);await expect(publish(userId,0,true)).rejects.toThrow('IMPORT_MEMBERSHIP_CHANGED');
  await publish(userId,1,false);expect(await repo.library(userId)).toHaveLength(0);expect(await store.transaction(tx=>tx.getMembershipRevision(userId))).toBe(2);
 },30000);
 test('ambiguous destructive work blocks publication even after its lease expires',async()=>{
  const {userId,input}=await setup();await repo.createDecision(input);const lease=(await repo.claimReviewWork('worker',Date.now(),60000))!;expect(lease.userId).toBe(userId);
  await db.transaction(async tx=>{await tx`UPDATE review_work_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=${userId}`;});
  await expect(publish(userId,1,false)).rejects.toThrow('MEMBERSHIP_MUTATION_PENDING');expect(await repo.library(userId)).toHaveLength(1);expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(1);
  // The conflict is owner-scoped, and a missing baseline fails closed.
  const other=await setup();await publish(other.userId,1,true);
  const legacy={userId:other.userId,jobId:crypto.randomUUID(),pass:0,trackIds:[],sourceTotal:0,observedAt:new Date().toISOString()};await expect(store.transaction(tx=>tx.completeImportMembership(legacy as never))).rejects.toThrow('IMPORT_MEMBERSHIP_CHANGED');
 },30000);
});
