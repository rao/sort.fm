import {test,expect,describe,beforeAll,afterAll} from 'bun:test';import {Database} from '../src/client';import {migrate} from '../src/migrate';import {PostgresPolicyStore} from '../src/policy-store';import {policyFixture} from './policy-fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('policy release and crash recovery',()=>{
 let db:Database,store:PostgresPolicyStore;
 beforeAll(async()=>{db=new Database(url!,`test_policy_recovery_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);store=new PostgresPolicyStore(db);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},60000);
 async function abandoned(published=false){const f=await policyFixture(db),input=f.adaptive(),p=await store.prepareSelection(input),response=f.response(input);if(published)await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,...response});await store.releaseSelection({userId:f.userId,requestId:input.requestId,releaseId:crypto.randomUUID(),exposureIds:[response.decision.exposureId],reason:'abandoned',...(!published?{expectedLeaseId:p.intent.lease!.leaseId}:{})});return {...f,input,p,response};}
 const age=(userId:string)=>db.transaction(tx=>tx`UPDATE policy_selection_intents SET created_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '61 seconds' WHERE user_id=${userId}`);
 test('fresh late404 resolves only an unpublished intent; late remote completion cannot publish or earn reward',async()=>{
  const f=await abandoned(),l=(await store.claimPolicyDelivery({workerId:'release',leaseMs:60000}))!;
  const ack={userId:f.userId,eventId:l.event.eventId,leaseId:l.leaseId,kind:'release_absent' as const,exposureId:f.response.decision.exposureId,checkedAt:new Date().toISOString(),providerStatus:404 as const};
  await expect(store.acknowledgePolicyDelivery(ack)).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});await age(f.userId);
  await expect(store.acknowledgePolicyDelivery({...ack,exposureId:crypto.randomUUID()})).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});await expect(store.acknowledgePolicyDelivery({...ack,checkedAt:new Date(Date.now()+60000).toISOString()})).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});await expect(store.acknowledgePolicyDelivery({...ack,checkedAt:new Date(Date.now()-120000).toISOString()})).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
  expect(await store.acknowledgePolicyDelivery({...ack,checkedAt:new Date().toISOString()})).toBe(true);expect((await store.publishSelection({userId:f.userId,requestId:f.input.requestId,leaseId:f.p.intent.lease!.leaseId,...f.response})).outcome).toBe('rejected');expect(await store.currentSelection(f.userId)).toBeNull();
  const [event]=await db.transaction(tx=>tx`SELECT disposition,receipt FROM policy_delivery_events WHERE event_id=${l.event.eventId}`);expect(event.disposition).toBe('absent_after_deadline');expect(event.receipt.kind).toBe('release_absent');expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE user_id=${f.userId}`)).toHaveLength(0);
 },60000);
 test('published exposure cannot use absence escape; authentic exact release receipt closes it',async()=>{
  const f=await abandoned(true);await age(f.userId);const l=(await store.claimPolicyDelivery({workerId:'published',leaseMs:60000}))!;if(l.event.kind!=='release')throw Error('release required');
  await expect(store.acknowledgePolicyDelivery({userId:f.userId,eventId:l.event.eventId,leaseId:l.leaseId,kind:'release_absent',exposureId:f.response.decision.exposureId,checkedAt:new Date().toISOString(),providerStatus:404})).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
  const receipt={...l.event.request,trackId:f.response.decision.trackId,outcome:'released' as const,recordedAt:new Date().toISOString(),expiresAt:f.response.providerExpiresAt,effectiveClosedAt:new Date().toISOString()};const {reason:ignored,...valid}=receipt;
  expect(await store.acknowledgePolicyDelivery({userId:f.userId,eventId:l.event.eventId,leaseId:l.leaseId,kind:'release',receipt:valid})).toBe(true);expect((await store.currentSelection(f.userId))!.servableExposureIds).toEqual([]);
 },60000);
 test('expired delivery leases recover with the same event and bounded backoff; stale acknowledgement cannot clear them',async()=>{
  const f=await abandoned(),first=(await store.claimPolicyDelivery({workerId:'first',leaseMs:60000}))!;
  await db.transaction(tx=>tx`UPDATE policy_delivery_events SET lease_until=clock_timestamp()-interval '1 second' WHERE event_id=${first.event.eventId}`);
  const second=(await new PostgresPolicyStore(db).claimPolicyDelivery({workerId:'restart',leaseMs:60000}))!;expect(second.event).toEqual(first.event);expect(second.attempts).toBe(2);await age(f.userId);
  expect(await store.acknowledgePolicyDelivery({userId:f.userId,eventId:first.event.eventId,leaseId:first.leaseId,kind:'release_absent',exposureId:f.response.decision.exposureId,checkedAt:new Date().toISOString(),providerStatus:404})).toBe(false);
  expect(await store.retryPolicyDelivery({userId:f.userId,eventId:second.event.eventId,leaseId:second.leaseId,retryAt:new Date(Date.now()+86400000).toISOString(),errorCode:'POLICY_TIMEOUT'})).toBe(true);
  const [row]=await db.transaction(tx=>tx`SELECT extract(epoch FROM available_at-clock_timestamp()) AS wait FROM policy_delivery_events WHERE event_id=${second.event.eventId}`);expect(Number(row.wait)).toBeGreaterThan(0);expect(Number(row.wait)).toBeLessThanOrEqual(300);expect(await store.claimPolicyDelivery({workerId:'early',leaseMs:60000})).toBeNull();
  await db.transaction(tx=>tx`UPDATE policy_delivery_events SET available_at=clock_timestamp() WHERE event_id=${second.event.eventId}`);const recovered=(await store.claimPolicyDelivery({workerId:'final',leaseMs:60000}))!;expect(await store.acknowledgePolicyDelivery({userId:f.userId,eventId:recovered.event.eventId,leaseId:recovered.leaseId,kind:'release_absent',exposureId:f.response.decision.exposureId,checkedAt:new Date().toISOString(),providerStatus:404})).toBe(true);
 },60000);
 test('rollback of a C1 page leaves no half-page and exact prepared request can resume',async()=>{
  const f=await policyFixture(db),input=f.c1(),p=await store.prepareSelection(input);if(input.draft.kind!=='c1')throw Error('c1 required');
  await db.transaction(async tx=>{await tx.unsafe("CREATE FUNCTION reject_policy_exposure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.payload->'exposure'->>'position')::int=1 THEN RAISE EXCEPTION 'TEST_PAGE_ROLLBACK'; END IF; RETURN NEW; END $$");await tx.unsafe('CREATE TRIGGER reject_policy_exposure BEFORE INSERT ON exposures FOR EACH ROW EXECUTE FUNCTION reject_policy_exposure()');});
  const publish={userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,kind:'c1' as const};try{await expect(store.publishSelection(publish)).rejects.toThrow('TEST_PAGE_ROLLBACK');expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE user_id=${f.userId}`)).toHaveLength(0);expect(await store.currentSelection(f.userId)).toBeNull();}finally{await db.transaction(tx=>tx.unsafe('DROP TRIGGER reject_policy_exposure ON exposures'));}
  expect((await store.publishSelection(publish)).outcome).toBe('published');expect((await store.currentSelection(f.userId))!.servableExposureIds).toHaveLength(2);
 },60000);
 test('already-closed receipt preserves original closure through clock rollback without accepting a future new release',async()=>{
  const f=await abandoned(true),l=(await store.claimPolicyDelivery({workerId:'rollback',leaseMs:60000}))!;if(l.event.kind!=='release')throw Error('release required');
  const receipt={userId:f.userId,requestId:l.event.request.requestId,exposureId:l.event.request.exposureId,trackId:f.response.decision.trackId,outcome:'released' as const,recordedAt:new Date().toISOString(),expiresAt:f.response.providerExpiresAt,effectiveClosedAt:new Date(Date.now()+1000).toISOString()};
  const ack={userId:f.userId,eventId:l.event.eventId,leaseId:l.leaseId,kind:'release' as const,receipt};
  await expect(store.acknowledgePolicyDelivery(ack)).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
  expect(await store.acknowledgePolicyDelivery({...ack,receipt:{...receipt,outcome:'already_closed'}})).toBe(true);
 },60000);

});
