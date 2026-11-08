import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database,json} from '../src/client';import {migrate} from '../src/migrate';import {PostgresA1Store} from '../src/a1-store';import {PostgresPolicyStore} from '../src/policy-store';import {PostgresCalibrationStore} from '../src/calibration';import {PostgresCalibrationBatchStore} from '../src/calibration-batch';
import {policyFixture} from './policy-fixtures';import {row,prediction} from '../../../apps/api/src/calibration/test-fixtures';import {selectCalibrationBatch,BATCH_ALGORITHM} from '../../../apps/api/src/calibration/batch-selection';import {createIdempotencyKey} from '@sortfm/contracts/client';import type {ListeningContextSnapshot,TasteContext,CalibrationBatchDraft} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
const coverage=(asOf=new Date().toISOString()):ListeningContextSnapshot=>({source:'spotify-recently-played',completeHistory:false,sampleLimit:50,status:'fresh',asOf,fetchedAt:asOf,ageMs:0,windowStart:new Date(Date.parse(asOf)-30*86400000).toISOString(),cachedEventCount:1,uniqueEventCount:1,windowEventCount:1});
describe.skipIf(!url)('cached listening persistence',()=>{
 let db:Database;
 beforeAll(async()=>{db=new Database(url!,`test_listening_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},60000);
 test('cached reads are owner-scoped, detached and validated without rewriting freshness or incomplete history',async()=>{
  const f=await policyFixture(db),other=await policyFixture(db),store=new PostgresA1Store(db),read=(userId=f.userId)=>store.transaction(tx=>tx.getTasteContext!(userId));
  expect(await read()).toBeNull();const event={trackId:f.tracks[0]!.trackId,playedAt:new Date(Date.now()-2*86400000).toISOString()},context:TasteContext={userId:f.userId,fetchedAt:event.playedAt,source:'spotify-recently-played',completeHistory:false,events:[event,event],error:null};
  await store.transaction(tx=>tx.putTasteContext(context));expect(await read(other.userId)).toBeNull();const detached=(await read())!;expect(detached).toEqual(context);detached.events.length=0;expect((await read())!.events).toHaveLength(2);
  const failed={...context,error:{code:'PROVIDER_TIMEOUT',message:'Generated safe fixture',retryable:true}};await store.transaction(tx=>tx.putTasteContext(failed));expect(await read()).toEqual(failed);
  for(const invalid of [{...context,userId:other.userId},{...context,completeHistory:true},{...context,events:[{...event,playedAt:'bad'}]},{...context,events:Array(51).fill(event)},{...context,source:'foreign'},{...context,fetchedAt:'bad'}]){await db.transaction(tx=>tx`UPDATE taste_context SET context=${json(invalid)}::jsonb WHERE user_id=${f.userId}`);expect(await read()).toBeNull();}
 },60000);
 test('adaptive metadata is frozen before I/O, recovered unchanged and cannot be replaced on publication; C1 omission stays legacy',async()=>{
  const f=await policyFixture(db),store=new PostgresPolicyStore(db),input=f.adaptive();if(input.draft.kind!=='adaptive')throw Error('adaptive required');input.draft.listeningContext=coverage();const p=await store.prepareSelection(input);
  await db.transaction(tx=>tx`UPDATE policy_selection_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=${f.userId}`);const recovered=(await store.claimSelectionRecovery({workerId:'listening-recovery',leaseMs:60000}))!;expect(recovered.draft).toEqual(input.draft);expect(recovered.expiresAt).toBe(p.intent.expiresAt);
  const response=f.response(input),publish={userId:f.userId,requestId:input.requestId,leaseId:recovered.lease!.leaseId,...response};
  await expect(store.publishSelection(publish)).rejects.toMatchObject({code:'POLICY_EXPOSURE_CONFLICT'});
  await expect(store.publishSelection({...publish,item:{...response.item,listeningContext:{...input.draft.listeningContext,cachedEventCount:2}}})).rejects.toMatchObject({code:'POLICY_EXPOSURE_CONFLICT'});
  const result=await store.publishSelection({...publish,item:{...response.item,listeningContext:input.draft.listeningContext}});expect(result.outcome).toBe('published');expect((await f.repo.getExposure(f.userId,response.decision.exposureId))!.listeningContext).toEqual(input.draft.listeningContext);
  const legacy=await policyFixture(db),c1=legacy.c1(1),prepared=await store.prepareSelection(c1);await store.publishSelection({userId:legacy.userId,requestId:c1.requestId,leaseId:prepared.intent.lease!.leaseId,kind:'c1'});expect((await store.currentSelection(legacy.userId))!.publication!.items[0]!.listeningContext).toBeUndefined();
 },60000);
 test('batch initial, replacement and revoked renewal retain only the original candidate coverage',async()=>{
  const f=await policyFixture(db),store=new PostgresCalibrationBatchStore(db),cal=new PostgresCalibrationStore(db),snapshot=coverage();let tick=Date.now();const time=()=>new Date(tick+=1000).toISOString();
  const candidates=Array.from({length:130},(_,i)=>{const r=row(i+100);return {track:r.track,features:{featureVersion:'sortfm.features.v1' as const,values:{saved_age_days:i},provenance:'spotify' as const,permittedForTraining:true},prediction:{...prediction,removalProbability:.5},...(i%2?{listeningContext:snapshot}:{})};});
  await f.repo.upsertSavedTracks(candidates.map(c=>({userId:f.userId,track:c.track,originalAddedAt:c.track.originalAddedAt,syncedAt:time(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId:f.userId,expectedMembershipRevision:1,jobId:crypto.randomUUID(),pass:0,trackIds:candidates.map(c=>c.track.trackId),sourceTotal:candidates.length,observedAt:time()}));
  const draft:CalibrationBatchDraft={batchId:crypto.randomUUID(),seed:42,modelVersion:prediction.modelVersion,algorithmVersion:BATCH_ALGORITHM,selectedAt:time(),candidates,...selectCalibrationBatch(candidates,42)},batch=await store.createCalibrationBatch(f.userId,draft);
  const expected=(id:string)=>candidates.find(c=>c.track.trackId===id)!.listeningContext;
  const original=await db.transaction(tx=>tx`SELECT payload FROM exposures WHERE user_id=${f.userId}`);for(const {payload} of original)expect(payload.listeningContext).toEqual(expected(payload.exposure.trackId));
  const first=batch.entries.find(e=>expected(e.trackId))!,label=await cal.createCalibrationLabel({userId:f.userId,labelId:crypto.randomUUID(),request:{trackId:first.trackId,exposureId:first.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'listening-label',createdAt:time()});
  await cal.undoCalibrationLabel({userId:f.userId,commandId:crypto.randomUUID(),labelId:label.labelId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'listening-undo',createdAt:time()});
  const renewed=(await store.calibrationBatch(f.userId,time()))!.entries.find(e=>e.batchItemId===first.batchItemId)!;expect(renewed.exposureId).not.toBe(first.exposureId);expect((await f.repo.getExposure(f.userId,renewed.exposureId))!.listeningContext).toEqual(snapshot);
  const skipped=batch.entries.find(e=>e.batchItemId!==first.batchItemId)!,next=await store.skipCalibrationBatch(f.userId,{exposureId:skipped.exposureId,idempotencyKey:createIdempotencyKey()},time()),replacement=next.entries.find(e=>e.replacementFor===skipped.batchItemId)!;
  expect((await f.repo.getExposure(f.userId,replacement.exposureId))!.listeningContext).toEqual(expected(replacement.trackId));
  for(const {payload} of original)expect(await f.repo.getExposure(f.userId,payload.exposure.exposureId)).toEqual(payload);
 },60000);
});
