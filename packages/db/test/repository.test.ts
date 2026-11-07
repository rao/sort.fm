import {test,expect,beforeAll,afterAll,describe} from 'bun:test';
import {Database} from '../src/client';
import {migrate} from '../src/migrate';
import {Repository} from '../src/repository';
import {FEATURE_VERSION} from '@sortfm/contracts';
import {demoTracks,createDemoQueue,emptyMetrics} from '@sortfm/contracts/fixtures';
import {createIdempotencyKey} from '@sortfm/contracts/client';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL repositories',()=>{
 let db:Database;let repo:Repository;
 const userId='test:one';const other='test:two';const track=demoTracks[0]!; const now=new Date().toISOString();
 const item=createDemoQueue({exposureId:()=>crypto.randomUUID(),limit:1}).items[0]!;
 const features={featureVersion:FEATURE_VERSION,values:{energy:null},provenance:'synthetic' as const,permittedForTraining:true};
 const decision={userId,decisionId:crypto.randomUUID(),request:{trackId:track.trackId,action:'KEEP' as const,exposureId:item.exposure.exposureId,idempotencyKey:createIdempotencyKey()},requestFingerprint:'first',createdAt:now};
 beforeAll(async()=>{db=new Database(url!,`test_d_${crypto.randomUUID().replaceAll('-','')}`);repo=new Repository(db);const result=await migrate(db);expect(result.applied).toHaveLength(9);expect((await migrate(db)).applied).toHaveLength(0);await repo.upsertUser({id:userId,spotifyId:null,displayName:'Test',avatarUrl:null});await repo.upsertUser({id:other,spotifyId:null,displayName:'Other',avatarUrl:null});});
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();});
 test('snapshots preserve first added time and status, nullable audio joins remain usable',async()=>{
  await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'kept'}]);
  await repo.upsertSavedTracks([{userId,track,originalAddedAt:now,syncedAt:now,currentStatus:'saved'}]);
  const [row]=await repo.library(userId);expect(row!.track.originalAddedAt).toBe(track.originalAddedAt);expect(row!.currentStatus).toBe('kept');expect(row!.audioFeatures).toBeNull();expect(await repo.library(other)).toHaveLength(0);
 });
 test('immutable exposures and commands dedupe, reject conflicting or cross-user use',async()=>{
  const exposure={userId,exposure:item.exposure,prediction:item.prediction,features};await repo.insertExposure(exposure);await repo.insertExposure(exposure);
  await expect(repo.insertExposure({...exposure,features:{...features,values:{energy:0.2}}})).rejects.toThrow('EXPOSURE_CONFLICT');
  expect((await repo.createDecision(decision)).decisionId).toBe(decision.decisionId);
  expect((await repo.getCurrentDecision(userId,track.trackId))!.decisionId).toBe(decision.decisionId);expect((await repo.library(userId))[0]!.currentDecision!.status).toBe('PENDING');
  expect((await repo.createDecision({...decision,decisionId:crypto.randomUUID()})).decisionId).toBe(decision.decisionId);
  await expect(repo.createDecision({...decision,requestFingerprint:'changed'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  expect(await repo.getDecision(other,decision.decisionId)).toBeNull();
  await expect(repo.createDecision({...decision,userId:other,decisionId:crypto.randomUUID()})).rejects.toThrow();
 });
 test('decision CAS activates feedback exactly once and undo revokes with monotonic revision',async()=>{
  const result={decisionId:decision.decisionId,trackId:track.trackId,action:'KEEP' as const,exposureId:item.exposure.exposureId,idempotencyKey:decision.request.idempotencyKey,status:'COMPLETE' as const,mutationStep:'NONE' as const,mode:'demo' as const,liked:true,archived:false,canUndo:true,label:0 as const,labelState:'active' as const,feedbackRevision:1,error:null,createdAt:now,updatedAt:now};
  await repo.settleDecision(userId,result,'PENDING','train');expect((await repo.trainingExamples(userId)).examples).toHaveLength(1);
  await repo.settleDecision(userId,result,'PENDING','train');expect((await repo.trainingExamples(userId)).feedbackRevision).toBe(1);
  const undo={userId,commandId:crypto.randomUUID(),decisionId:decision.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:now};await repo.createUndo(undo);
  await expect(repo.createDecision({...decision,decisionId:crypto.randomUUID(),request:{...decision.request,idempotencyKey:createIdempotencyKey()}})).rejects.toThrow('EXPOSURE_ALREADY_CONSUMED');
  await expect(repo.createUndo({...undo,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()}})).rejects.toThrow('MUTATION_PENDING');
  await repo.settleDecision(userId,{...result,status:'UNDONE',canUndo:false,label:null,labelState:'revoked',feedbackRevision:2},'COMPLETE','train');
  expect((await repo.trainingExamples(userId)).examples).toHaveLength(0);expect((await repo.trainingExamples(userId)).feedbackRevision).toBe(2);
 });
 test('telemetry dedupe is atomic and model versions are immutable',async()=>{
  const event={eventId:crypto.randomUUID(),userId,modelVersion:null,eventType:'decision' as const,predictionScore:0.7,uncertainty:0.2,processingLatencyMs:10,occurredAt:now};
  await repo.recordTelemetry(event);await repo.recordTelemetry(event);expect((await repo.analytics(userId,now.slice(0,10)+'T00:00:00Z',new Date(Date.now()+60000).toISOString())).find(r=>r.eventType==='decision'&&r.modelVersion===null)!.events).toBe(1);
  await expect(repo.recordTelemetry({...event,uncertainty:0.3})).rejects.toThrow('EVENT_CONFLICT');
  const model={runId:crypto.randomUUID(),userId,modelVersion:'untrained-v0',modelKind:'untrained',featureVersion:FEATURE_VERSION,artifactPath:'test/model',trainedExamples:0,feedbackRevision:2,metrics:emptyMetrics,createdAt:now};await repo.recordModelRun(model);await repo.recordModelRun(model);
  expect((await repo.latestModel(userId))!.modelVersion).toBe(model.modelVersion);
 });
});
