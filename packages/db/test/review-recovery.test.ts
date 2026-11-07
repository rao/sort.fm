import {test,expect,describe,beforeAll,beforeEach,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';
import {FEATURE_VERSION,type ReviewResult} from '@sortfm/contracts';import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
import {createIdempotencyKey} from '@sortfm/contracts/client';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable review work and non-idempotent effects',()=>{
 let db:Database;let repo:Repository;
 beforeAll(async()=>{db=new Database(url!,`test_recovery_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);await migrate(db);},30000);
 beforeEach(async()=>{await db.transaction(async tx=>{await tx`TRUNCATE review_work_leases,review_work`;});});
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30000);
 async function setup(count=1){const userId=`test:${crypto.randomUUID()}`;await repo.upsertUser({id:userId,spotifyId:null,displayName:'Test',avatarUrl:null});
  const results:ReviewResult[]=[];for(let i=0;i<count;i++){const track=demoTracks[i]!;const item=createDemoQueue({limit:count,exposureId:()=>crypto.randomUUID()}).items[i]!;const now=new Date().toISOString();
   await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'}]);
   await repo.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}});
   results.push(await repo.createDecision({userId,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action:'ARCHIVE',exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:now}));
  }return {userId,results};
 }
 async function expire(userId:string){await db.transaction(async tx=>{await tx`UPDATE review_work_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=${userId}`;});}
 const complete=(r:ReviewResult):ReviewResult=>({...r,status:'COMPLETE',mutationStep:'UNLIKED',liked:false,archived:true,canUndo:true,label:1,labelState:'active',feedbackRevision:1});
 test('one active owner lease; crash reclaim rejects stale, expired, cross-user and unfenced writes',async()=>{
  const {userId,results}=await setup(2);const first=(await repo.claimReviewWork('a',Date.now(),60000))!;expect(first.userId).toBe(userId);expect(first.commandId).toBe(results[0]!.decisionId);
  expect(await repo.claimReviewWork('b',Date.now()+99999999,60000)).toBeNull(); // Caller clock cannot steal ownership.
  expect(await repo.completeReviewWork(userId,first.leaseId)).toBe(false);
  await expect(repo.settleDecision(userId,complete(first.result),'PENDING','train')).rejects.toThrow('REVIEW_LEASE_REQUIRED');
  await expire(userId);expect(await repo.renewReviewWork(userId,first.leaseId,60000)).toBe(false);
  await expect(repo.settleDecision(userId,complete(first.result),'PENDING','train',first)).rejects.toThrow('REVIEW_LEASE_LOST');
  const recovered=(await repo.claimReviewWork('b',Date.now(),60000))!;expect(recovered.commandId).toBe(first.commandId);expect(recovered.leaseId).not.toBe(first.leaseId);
  const other=await setup();await expect(repo.settleDecision(userId,complete(first.result),'PENDING','train',{userId:other.userId,leaseId:recovered.leaseId})).rejects.toThrow('REVIEW_LEASE_LOST');
  expect(await repo.retryReviewWork(userId,first.leaseId,Date.now())).toBe(false);
  await repo.settleDecision(userId,complete(first.result),'PENDING','train',recovered);expect(await repo.completeReviewWork(userId,recovered.leaseId)).toBe(true);
  expect(await repo.completeReviewWork(userId,recovered.leaseId)).toBe(false);expect(await repo.renewReviewWork(userId,recovered.leaseId,60000)).toBe(false);
 },30000);
 test('competing dispatchers serialize one owner, journal writes are fenced, migration backfills unfinished commands',async()=>{
  const {userId}=await setup(2);const claims=await Promise.all(Array.from({length:8},(_,i)=>repo.claimReviewWork(`worker-${i}`,Date.now(),60000)));
  const winners=claims.filter(c=>c!==null);expect(winners).toHaveLength(1);const lease=winners[0]!;
  const input={userId,decisionId:lease.decisionId,mutationId:crypto.randomUUID(),expectedStatus:'PENDING' as const,status:'PENDING' as const,step:'PENDING' as const,attempts:1,archivePlaylistId:null,occurredAt:new Date().toISOString()};
  await expect(repo.transitionMutation(input)).rejects.toThrow('REVIEW_LEASE_REQUIRED');await repo.transitionMutation(input,lease);
  expect((await repo.getMutation(userId,lease.decisionId))!.attempts).toBe(1);expect(await repo.getMutation('unrelated',lease.decisionId)).toBeNull();
  await expire(userId);await expect(repo.transitionMutation({...input,attempts:2},lease)).rejects.toThrow('REVIEW_LEASE_LOST');
  expect((await repo.getMutation(userId,lease.decisionId))!.attempts).toBe(1);
  // Simulate the pre-008 schema with existing unfinished decisions, then run the real migration.
  await db.transaction(async tx=>{await tx`DROP TABLE review_effects,review_work_leases,review_work`;await tx`DELETE FROM schema_migrations WHERE name='008_review_recovery.sql'`;});
  expect((await migrate(db)).applied).toEqual(['008_review_recovery.sql']);
  await db.transaction(async tx=>{await tx`UPDATE review_work SET completed_at=clock_timestamp() WHERE user_id<>${userId}`;});
  const recovered=(await repo.claimReviewWork('restarted',Date.now(),60000))!;expect(recovered.userId).toBe(userId);expect(recovered.mutation?.attempts).toBe(1);
 },30000);
 test('immutable intents survive crash, ambiguous POST is not executable twice, retryable response is explicit',async()=>{
  const {userId}=await setup();const first=(await repo.claimReviewWork('a',Date.now(),60000))!;
  const request={kind:'create_archive' as const,name:'sort.fm Archive',public:false as const,description:`sort.fm archive [${userId}]`};
  expect((await repo.beginReviewEffect(first,request)).shouldExecute).toBe(true);
  await expect(repo.setArchivePlaylist(userId,'unfenced')).rejects.toThrow('REVIEW_LEASE_REQUIRED');
  await expire(userId);const second=(await repo.claimReviewWork('b',Date.now(),60000))!;
  expect((await repo.beginReviewEffect(second,request)).shouldExecute).toBe(false);expect((await repo.getReviewEffect(second,'create_archive'))!.state).toBe('intent');
  await expect(repo.settleReviewEffect(first,'create_archive','confirmed','playlist')).rejects.toThrow('REVIEW_LEASE_LOST');
  await expect(repo.beginReviewEffect(second,{...request,description:'different marker'})).rejects.toThrow('REVIEW_EFFECT_CONFLICT');
  await repo.settleReviewEffect(second,'create_archive','confirmed','playlist');expect(await repo.getArchivePlaylist(userId)).toBe('playlist');
  expect((await repo.beginReviewEffect(second,request)).shouldExecute).toBe(false);
  await expect(repo.settleReviewEffect(second,'create_archive','retryable',null)).rejects.toThrow('REVIEW_EFFECT_CONFLICT');
  const add={kind:'add_archive' as const,playlistId:'playlist',trackId:second.result.trackId};
  await expect(repo.beginReviewEffect(second,{...add,trackId:'wrong'})).rejects.toThrow('REVIEW_EFFECT_CONFLICT');
  expect((await repo.beginReviewEffect(second,add)).shouldExecute).toBe(true);await repo.settleReviewEffect(second,'add_archive','retryable',null);
  expect((await repo.beginReviewEffect(second,add)).shouldExecute).toBe(true);expect((await repo.beginReviewEffect(second,add)).shouldExecute).toBe(false);
  await repo.settleReviewEffect(second,'add_archive','confirmed','playlist');
  await expect(repo.beginReviewEffect(second,{...add,playlistId:'other'})).rejects.toThrow('REVIEW_EFFECT_CONFLICT');
 },30000);
 test('retry schedule and unsettled Undo survive restart; completion cannot discard ambiguous restoration',async()=>{
  const {userId}=await setup();const review=(await repo.claimReviewWork('a',Date.now(),60000))!;
  expect(await repo.retryReviewWork(userId,review.leaseId,Date.now()+60000)).toBe(true);expect(await repo.claimReviewWork('b',Date.now(),60000)).toBeNull();
  await db.transaction(async tx=>{await tx`UPDATE review_work SET available_at=clock_timestamp() WHERE user_id=${userId}`;});
  const resumed=(await repo.claimReviewWork('b',Date.now(),60000))!;await repo.settleDecision(userId,complete(review.result),'PENDING','train',resumed);expect(await repo.completeReviewWork(userId,resumed.leaseId)).toBe(true);
  const command={userId,commandId:crypto.randomUUID(),decisionId:review.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()};await repo.createUndo(command);
  expect(await repo.getPendingUndo(userId,review.decisionId)).toEqual(command);
  const undo=(await repo.claimReviewWork('c',Date.now(),60000))!;expect(undo.operation).toBe('undo');expect(undo.commandId).toBe(command.commandId);expect(undo.result.status).toBe('COMPLETE');
  expect(await repo.completeReviewWork(userId,undo.leaseId)).toBe(false);await expire(userId);const recovered=(await repo.claimReviewWork('d',Date.now(),60000))!;expect(recovered.commandId).toBe(command.commandId);
  await repo.settleDecision(userId,{...complete(review.result),status:'UNDONE',mutationStep:'RESTORED',canUndo:false,liked:true,label:null,labelState:'revoked',feedbackRevision:2},'COMPLETE','train',recovered);
  expect(await repo.completeReviewWork(userId,recovered.leaseId)).toBe(true);expect(await repo.getPendingUndo(userId,review.decisionId)).toBeNull();expect(await repo.claimReviewWork('e',Date.now(),60000)).toBeNull();
 },30000);
});
