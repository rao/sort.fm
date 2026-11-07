import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresA1Store} from '../src/a1-store';
import {FEATURE_VERSION,type DecisionInput,type ReviewResult} from '@sortfm/contracts';import {createIdempotencyKey} from '@sortfm/contracts/client';import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('atomic exposure and membership guards',()=>{
 let db:Database;let repo:Repository;let store:PostgresA1Store;const userId='test:guards',other='test:other';const track=demoTracks[0]!,now=new Date().toISOString();
 beforeAll(async()=>{db=new Database(url!,`test_guards_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);store=new PostgresA1Store(db);await migrate(db);for(const id of [userId,other]){await repo.upsertUser({id,spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertSavedTracks(demoTracks.slice(0,2).map(track=>({userId:id,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved' as const})));}await store.transaction(tx=>tx.completeImportMembership({userId,jobId:crypto.randomUUID(),pass:0,trackIds:[track.trackId],sourceTotal:1,observedAt:now}));},30000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30000);
 async function command(servedAt:string,owner=userId):Promise<DecisionInput>{const item=createDemoQueue({limit:1,servedAt,exposureId:()=>crypto.randomUUID()}).items[0]!;await repo.insertExposure({userId:owner,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}});return {userId:owner,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action:'UNLIKE',exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:'request',createdAt:servedAt};}
 test('owner and track checked before consumption; concurrent distinct keys consume exposure exactly once',async()=>{
  const input=await command(now);await expect(repo.createDecision({...input,userId:other})).rejects.toThrow('EXPOSURE_NOT_FOUND');
  await expect(repo.createDecision({...input,request:{...input.request,trackId:demoTracks[1]!.trackId}})).rejects.toThrow('EXPOSURE_TRACK_MISMATCH');
  const contenders=[input,{...input,decisionId:crypto.randomUUID(),request:{...input.request,idempotencyKey:createIdempotencyKey()}}];
  const outcomes=await Promise.allSettled(contenders.map(c=>repo.createDecision(c)));expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(r=>r.status==='rejected')).toMatchObject({reason:{message:'EXPOSURE_ALREADY_CONSUMED'}});
  const pending=(await repo.getCurrentDecision(userId,track.trackId))!;const winner=contenders.find(c=>c.decisionId===pending.decisionId)!;
  const complete:ReviewResult={...pending,status:'COMPLETE',mutationStep:'UNLIKED',liked:false,archived:false,canUndo:true,label:1,labelState:'active',feedbackRevision:1,updatedAt:new Date(Date.parse(now)+1000).toISOString()};
  await repo.settleDecision(userId,complete,'PENDING','train');
  expect(await repo.createDecision({...winner,decisionId:crypto.randomUUID()})).toEqual(complete);expect(await repo.getDecisionByIdempotencyKey(userId,winner.request.idempotencyKey)).toEqual(complete);expect(await repo.getDecisionByIdempotencyKey(other,winner.request.idempotencyKey)).toBeNull();
  await expect(repo.createDecision({...winner,requestFingerprint:'different'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  const fresh=await command(new Date(Date.parse(now)+2000).toISOString());await expect(repo.createDecision(fresh)).rejects.toThrow('TRACK_NOT_IN_LIBRARY');
  const undo={userId,commandId:crypto.randomUUID(),decisionId:complete.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:now};await repo.createUndo(undo);
  const undoTime=new Date(Date.parse(now)+3000).toISOString();await repo.settleDecision(userId,{...complete,status:'UNDONE',mutationStep:'RESTORED',liked:true,canUndo:false,label:null,labelState:'revoked',feedbackRevision:2,updatedAt:undoTime},'COMPLETE','train');
  expect(await repo.createUndo({...undo,commandId:crypto.randomUUID()})).toEqual(undo);expect(await repo.getUndoByIdempotencyKey(userId,undo.request.idempotencyKey)).toEqual(undo);expect(await repo.getUndoByIdempotencyKey(other,undo.request.idempotencyKey)).toBeNull();
  await expect(repo.createDecision(fresh)).rejects.toThrow('STALE_EXPOSURE');
  await expect(repo.createDecision(await command(undoTime))).rejects.toThrow('STALE_EXPOSURE');
  expect((await repo.createDecision(await command(new Date(Date.parse(undoTime)+1).toISOString()))).status).toBe('PENDING');
 },30000);
});
