import {test,expect,describe,beforeAll,afterAll} from 'bun:test';import {Database} from '../src/client';import {migrate} from '../src/migrate';import {PostgresPolicyStore} from '../src/policy-store';import {policyFixture,policyTelemetry} from './policy-fixtures';import {createIdempotencyKey} from '@sortfm/contracts/client';import {PostgresCalibrationStore} from '../src/calibration';import type {ReviewResult,PolicyDeliveryLease} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('committed policy delivery',()=>{
 let db:Database,store:PostgresPolicyStore;
 beforeAll(async()=>{db=new Database(url!,`test_policy_delivery_${crypto.randomUUID().replaceAll('-','')}`);await migrate(db);store=new PostgresPolicyStore(db);},60000);
 afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},60000);
 const events=(userId:string)=>db.transaction(tx=>tx`SELECT * FROM policy_delivery_events WHERE user_id=${userId} ORDER BY sequence`);
 async function selected(){const f=await policyFixture(db),input=f.adaptive(),p=await store.prepareSelection(input),response=f.response(input);await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,...response});return {...f,input,response};}
 async function complete(f:Awaited<ReturnType<typeof selected>>,action:'KEEP'|'SKIP'='KEEP'){
  const pending=await f.repo.createDecision({userId:f.userId,decisionId:crypto.randomUUID(),request:{trackId:f.response.item.exposure.trackId,exposureId:f.response.item.exposure.exposureId,action,idempotencyKey:createIdempotencyKey()},requestFingerprint:crypto.randomUUID(),createdAt:new Date().toISOString()});
  const result:ReviewResult={...pending,status:'COMPLETE',mutationStep:'NONE',canUndo:true,label:action==='KEEP'?0:null,labelState:action==='KEEP'?'active':'inactive',feedbackRevision:action==='KEEP'?1:0,updatedAt:new Date().toISOString()};await f.repo.settleDecision(f.userId,result,'PENDING','train');return result;
 }
 const ack=(l:PolicyDeliveryLease)=>({userId:l.event.userId,eventId:l.event.eventId,leaseId:l.leaseId,kind:'associate' as const,receipt:{userId:l.event.userId,eventId:l.event.eventId,sequence:l.event.sequence,recordedAt:new Date().toISOString(),duplicate:false,fitReceipt:l.fitReceipt!,eligibleForLearning:false}});
 test('actual fit receipts persist independently and numeric-only acknowledgements never invent one',async()=>{
  const f=await policyFixture(db);expect(await f.repo.recordPolicyFitReceipt(f.userId,f.fit(0))).toBe(true);expect(await f.repo.recordPolicyFitReceipt(f.userId,f.fit(0))).toBe(true);expect(await f.repo.recordPolicyFitReceipt(f.userId,f.fit(1))).toBe(false);expect(await f.repo.recordPolicyFitReceipt(f.userId,f.fit(0,'conflicting'))).toBe(false);
  await expect(f.repo.recordPolicyFitReceipt(f.userId,{...f.fit(0),userId:'foreign'})).rejects.toMatchObject({code:'POLICY_FIT_RECEIPT_INVALID'});
  const other=await policyFixture(db);await db.transaction(async tx=>{await tx`UPDATE users SET feedback_revision=1 WHERE id=${other.userId}`;await tx`INSERT INTO feedback_sync_jobs(user_id,target_revision) VALUES(${other.userId},1)`;});
  const job=(await other.repo.claimFeedbackSync('legacy',Date.now(),60000))!;expect(await other.repo.acknowledgeFeedbackSync(other.userId,job.leaseId,1)).toBe(true);expect((await store.reviewCandidates(other.userId)).fitReceipt).toBeNull();expect(await other.repo.recordPolicyFitReceipt(other.userId,other.fit(1))).toBe(true);expect(await other.repo.recordPolicyFitReceipt(other.userId,other.fit(0))).toBe(false);
  expect((await store.reviewCandidates(other.userId)).fitReceipt).toEqual({modelVersion:'generated-model-1',synchronizedFeedbackRevision:1});
 },60000);
 test('settlement and Undo enqueue immutable ordered associations once, with covering fit receipts on retry',async()=>{
  const f=await selected(),result=await complete(f);await f.repo.settleDecision(f.userId,result,'PENDING','train');expect(await events(f.userId)).toHaveLength(1);expect(await store.claimPolicyDelivery({workerId:'not-fit',leaseMs:60000})).toBeNull();
  const job=(await f.repo.claimFeedbackSync('fit',Date.now(),60000))!;expect(await f.repo.acknowledgeFeedbackSync(f.userId,job.leaseId,1,f.fit(1))).toBe(true);
  const first=(await store.claimPolicyDelivery({workerId:'one',leaseMs:60000}))!;expect(first.event.kind).toBe('associate');if(first.event.kind!=='associate')throw Error('wrong kind');expect(first.event.event).toMatchObject({decisionId:result.decisionId,exposureId:result.exposureId,source:'cleanup',operation:'upsert',label:0,feedbackRevision:1,sequence:1});expect(first.event.event.features).toEqual(f.response.item.features);
  await f.repo.createUndo({userId:f.userId,commandId:crypto.randomUUID(),decisionId:result.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()});await f.repo.settleDecision(f.userId,{...result,status:'UNDONE',label:null,labelState:'revoked',canUndo:false,feedbackRevision:2,updatedAt:new Date().toISOString()},'COMPLETE','train');expect(await events(f.userId)).toHaveLength(2);
  await f.repo.recordPolicyFitReceipt(f.userId,f.fit(2));expect(await store.retryPolicyDelivery({userId:f.userId,eventId:first.event.eventId,leaseId:first.leaseId,retryAt:new Date().toISOString(),errorCode:'POLICY_TIMEOUT'})).toBe(true);
  await db.transaction(tx=>tx`UPDATE policy_delivery_events SET available_at=clock_timestamp() WHERE user_id=${f.userId}`);
  const retry=(await new PostgresPolicyStore(db).claimPolicyDelivery({workerId:'two',leaseMs:60000}))!;expect(retry.event).toEqual(first.event);expect(retry.fitReceipt!.synchronizedFeedbackRevision).toBe(2);expect(await store.acknowledgePolicyDelivery(ack(first))).toBe(false);expect(await store.acknowledgePolicyDelivery(ack(retry))).toBe(true);
  const revoke=(await store.claimPolicyDelivery({workerId:'three',leaseMs:60000}))!;expect(revoke.event.sequence).toBe(2);if(revoke.event.kind!=='associate')throw Error('wrong kind');expect(revoke.event.event.operation).toBe('revoke');expect(revoke.event.event.label).toBeNull();expect(await store.acknowledgePolicyDelivery(ack(revoke))).toBe(true);
  expect((await store.reviewCandidates(f.userId)).eligibleTrackIds).toContain(result.trackId);expect((await store.currentSelection(f.userId))!.servableExposureIds).toEqual([]);
 },60000);
 test('SKIP emits a null-label event without advancing the C1 revision and cannot train a reward',async()=>{
  const f=await selected();await f.repo.recordPolicyFitReceipt(f.userId,f.fit(0));const result=await complete(f,'SKIP');const rows=await events(f.userId);expect(rows).toHaveLength(1);expect(rows[0].payload).toMatchObject({label:null,feedbackRevision:0,sequence:1});expect((await f.repo.trainingExamples(f.userId)).feedbackRevision).toBe(0);expect((await store.reviewCandidates(f.userId)).eligibleTrackIds).toContain(result.trackId);
  const l=(await store.claimPolicyDelivery({workerId:'skip',leaseMs:60000}))!;await expect(store.acknowledgePolicyDelivery({...ack(l),receipt:{...ack(l).receipt,eligibleForLearning:true}})).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});expect(await store.acknowledgePolicyDelivery(ack(l))).toBe(true);
 },60000);
 test('calibration and unbound C1 decisions create no associations; outbox failure rolls settlement back',async()=>{
  const f=await policyFixture(db),cal=new PostgresCalibrationStore(db),e=f.item(1);await cal.insertCalibrationExposure(e);await cal.createCalibrationLabel({userId:f.userId,labelId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,label:1,idempotencyKey:createIdempotencyKey()},requestFingerprint:'calibration',createdAt:new Date().toISOString()});expect(await events(f.userId)).toHaveLength(0);
  const bound=await selected();await db.transaction(async tx=>{await tx.unsafe("CREATE FUNCTION reject_policy_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_OUTBOX_FAILURE'; END $$");await tx.unsafe('CREATE TRIGGER reject_policy_event BEFORE INSERT ON policy_delivery_events FOR EACH ROW EXECUTE FUNCTION reject_policy_event()');});
  try{await expect(complete(bound)).rejects.toThrow('TEST_OUTBOX_FAILURE');expect((await bound.repo.history(bound.userId))[0]!.status).toBe('PENDING');expect((await bound.repo.trainingExamples(bound.userId)).feedbackRevision).toBe(0);expect(await events(bound.userId)).toHaveLength(0);}finally{await db.transaction(tx=>tx.unsafe('DROP TRIGGER reject_policy_event ON policy_delivery_events'));}
 },60000);
 test('authenticated C2 cold-start C1 selection stays bound and seeds committed policy feedback',async()=>{
  const f=await policyFixture(db),input=f.adaptive(),p=await store.prepareSelection(input),response=f.response(input);
  response.decision.selection.selectionMethod='c1';response.item.exposure.selectionMethod='deterministic_baseline';response.item.exposure.policyTelemetry=policyTelemetry(response.decision,response.providerExpiresAt);
  expect((await store.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,...response})).outcome).toBe('published');
  const result=await complete({...f,input,response});expect(await events(f.userId)).toHaveLength(1);expect((await events(f.userId))[0].payload.decisionId).toBe(result.decisionId);
 },60000);
 test('conflicting same-revision receipt cannot clear a fit job; a newer covering receipt is preserved',async()=>{
  const f=await policyFixture(db);await db.transaction(async tx=>{await tx`UPDATE users SET feedback_revision=2 WHERE id=${f.userId}`;await tx`INSERT INTO feedback_sync_jobs(user_id,target_revision) VALUES(${f.userId},1)`;});
  await f.repo.recordPolicyFitReceipt(f.userId,f.fit(1));const job={leaseId:crypto.randomUUID()};await db.transaction(tx=>tx`UPDATE feedback_sync_jobs SET lease_id=${job.leaseId},lease_until=clock_timestamp()+interval '60 seconds' WHERE user_id=${f.userId}`);
  await expect(f.repo.acknowledgeFeedbackSync(f.userId,job.leaseId,1,f.fit(1,'conflict'))).rejects.toMatchObject({code:'POLICY_FIT_RECEIPT_CONFLICT'});
  const [pending]=await db.transaction(tx=>tx`SELECT acknowledged_revision,lease_id FROM feedback_sync_jobs WHERE user_id=${f.userId}`);expect(pending.acknowledged_revision).toBe(0);expect(pending.lease_id).toBe(job.leaseId);
  await f.repo.recordPolicyFitReceipt(f.userId,f.fit(2));expect(await f.repo.acknowledgeFeedbackSync(f.userId,job.leaseId,1,f.fit(1))).toBe(true);expect((await store.reviewCandidates(f.userId)).fitReceipt).toEqual({modelVersion:'generated-model-2',synchronizedFeedbackRevision:2});
 },60000);

});
