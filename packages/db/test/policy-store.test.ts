import {test,expect,describe,beforeAll,afterAll} from 'bun:test';import {Database} from '../src/client';import {migrate} from '../src/migrate';import {PostgresPolicyStore} from '../src/policy-store';import {policyFixture,policyTelemetry} from './policy-fixtures';import {createIdempotencyKey} from '@sortfm/contracts/client';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('durable policy publication',()=>{
 let db:Database,store:PostgresPolicyStore;
 beforeAll(async()=>{db=new Database(url!,`test_policy_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);store=new PostgresPolicyStore(db);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},60000);
 test('C1 page publishes atomically, reuses current page and preserves truthful remaining',async()=>{
  const f=await policyFixture(db),input=f.c1(),prepared=await store.prepareSelection(input);expect(prepared.outcome).toBe('claimed');const fence={userId:f.userId,requestId:input.requestId,leaseId:prepared.intent.lease!.leaseId};
  expect((await store.prepareSelection(input)).outcome).toBe('in_progress');const published=await store.publishSelection({...fence,kind:'c1'});expect(published.outcome).toBe('published');
  const current=(await new PostgresPolicyStore(db).currentSelection(f.userId))!;expect(current.servableExposureIds).toHaveLength(2);expect(current.publication!.items).toEqual(input.draft.kind==='c1'?input.draft.items:[]);expect((await store.prepareSelection(input)).outcome).toBe('replay');
  const candidates=await store.reviewCandidates(f.userId);expect(candidates.remaining).toBe(5);expect(candidates.eligibleTrackIds).toHaveLength(3);
  const id=current.servableExposureIds[0]!,release={userId:f.userId,requestId:input.requestId,releaseId:crypto.randomUUID(),exposureIds:[id],reason:'prefetch_discarded' as const};const receipt=await store.releaseSelection(release);expect(await store.releaseSelection(release)).toEqual(receipt);expect((await store.currentSelection(f.userId))!.servableExposureIds).toHaveLength(1);expect((await store.reviewCandidates(f.userId)).eligibleTrackIds).toHaveLength(4);
  await expect(store.releaseSelection({...release,reason:'skip'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect((await store.publishSelection({...fence,kind:'c1'})).intent.expiresAt).toBe(current.expiresAt);
 },60000);
 test('publication rechecks pending KEEP without revision drift and never leaves half a C1 page',async()=>{
  const f=await policyFixture(db),input=f.c1(),p=await store.prepareSelection(input),e=f.item();await f.repo.insertExposure(e);await f.repo.createDecision({userId:f.userId,decisionId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP',idempotencyKey:createIdempotencyKey()},requestFingerprint:'pending',createdAt:new Date().toISOString()});
  const outcome=await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,kind:'c1'});expect(outcome.outcome).toBe('rejected');expect(outcome).toMatchObject({reason:'candidates_changed'});expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE user_id=${f.userId}`)).toHaveLength(1);
 },60000);
 test('adaptive publication preserves exact pins and enforces lease recovery against old workers',async()=>{
  const f=await policyFixture(db),input=f.adaptive(),p=await store.prepareSelection(input);await expect(store.prepareSelection({...input,leaseMs:30000})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await db.transaction(tx=>tx`UPDATE policy_selection_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=${f.userId}`);
  const recovered=(await store.claimSelectionRecovery({workerId:'recovered',leaseMs:60000}))!;expect(recovered.draft).toEqual(input.draft);expect(recovered.lease!.leaseId).not.toBe(p.intent.lease!.leaseId);expect(recovered.expiresAt).toBe(p.intent.expiresAt);
  const response=f.response(input);expect(await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,...response})).toMatchObject({reason:'lease_lost'});
  await expect(store.releaseSelection({userId:f.userId,requestId:input.requestId,releaseId:crypto.randomUUID(),exposureIds:[response.decision.exposureId],reason:'abandoned',expectedLeaseId:p.intent.lease!.leaseId})).rejects.toMatchObject({code:'POLICY_LEASE_LOST'});
  await expect(store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:recovered.lease!.leaseId,...response,decision:{...response.decision,feedbackRevision:1}})).rejects.toMatchObject({code:'POLICY_EXPOSURE_CONFLICT'});
  expect((await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:recovered.lease!.leaseId,...response})).outcome).toBe('published');expect((await store.currentSelection(f.userId))!.publication!.policyDecision).toEqual(response.decision);
 },60000);
 test('released cards cannot create fresh review commands, while recorded command retries still recover',async()=>{
  const f=await policyFixture(db),input=f.c1(),p=await store.prepareSelection(input);await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,kind:'c1'});
  const page=(await store.currentSelection(f.userId))!,first=page.publication!.items[0]!,second=page.publication!.items[1]!;
  await store.releaseSelection({userId:f.userId,requestId:input.requestId,releaseId:crypto.randomUUID(),exposureIds:[first.exposure.exposureId],reason:'prefetch_discarded'});
  const command=(e:typeof first)=>({userId:f.userId,decisionId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP' as const,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:new Date().toISOString()});
  await expect(f.repo.createDecision(command(first))).rejects.toMatchObject({code:'POLICY_EXPOSURE_CLOSED'});const input2=command(second),pending=await f.repo.createDecision(input2);
  await store.currentSelection(f.userId);expect(await f.repo.createDecision(input2)).toEqual(pending);
 },60000);
 test('adaptive publication rejects contradictory telemetry and accepts bounded cached decisions after clock rollback',async()=>{
  const f=await policyFixture(db),input=f.adaptive(),prepared=await store.prepareSelection(input),response=f.response(input);
  const publish={userId:f.userId,requestId:input.requestId,leaseId:prepared.intent.lease!.leaseId,...response};
  const original=response.item.exposure,telemetry=original.policyTelemetry!;
  const mutations=[{policyTelemetry:undefined},{propensityEstimate:.9},{explorationCoefficient:original.explorationCoefficient+1},{servedAt:new Date(Date.now()-1000).toISOString()},{policyTelemetry:{...telemetry,predictedReward:99}},{policyTelemetry:{...telemetry,reservation:{...telemetry.reservation,expiresAt:new Date(Date.parse(response.providerExpiresAt)+1000).toISOString()}}}];
  for(const patch of mutations)await expect(store.publishSelection({...publish,item:{...response.item,exposure:{...original,...patch}}})).rejects.toMatchObject({code:'POLICY_EXPOSURE_CONFLICT'});
  expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE user_id=${f.userId}`)).toHaveLength(0);
  response.decision.createdAt=new Date(Date.now()+60000).toISOString();response.providerExpiresAt=new Date(Date.parse(response.decision.createdAt)+300000).toISOString();response.item.exposure.servedAt=response.decision.createdAt;response.item.exposure.policyTelemetry=policyTelemetry(response.decision,response.providerExpiresAt);
  const result=await store.publishSelection({...publish,...response});expect(result.outcome).toBe('published');expect(result.intent.publication!.reservations[0]!.expiresAt).toBe(prepared.intent.expiresAt);
 },60000);

});
