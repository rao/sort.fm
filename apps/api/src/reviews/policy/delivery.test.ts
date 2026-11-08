import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type PolicyDeliveryLease,type PolicyDeliveryAck,type PolicyStore,type PolicyAssociationRequest,type PolicyAssociationReceipt,type PolicyReleaseReceipt} from '@sortfm/contracts';
import {MlClientError,type PolicyClient} from '../../ml/client';
import {PolicyDeliveryWorker} from './delivery';
import {policyInspection} from './fixtures';

const now=Date.parse('2026-11-07T12:00:00Z'),at=new Date(now).toISOString(),owner='demo:policy-owner';
function association():PolicyDeliveryLease {
 const eventId=crypto.randomUUID();
 return {event:{userId:owner,eventId,sequence:1,createdAt:at,kind:'associate',event:{eventId,sequence:1,source:'cleanup',decisionId:crypto.randomUUID(),exposureId:policyInspection.decision.exposureId,trackId:'demo:track',policyVersion:'test:policy:v1',modelVersion:'test:c1:r3',operation:'upsert',feedbackRevision:4,label:1,features:{featureVersion:FEATURE_VERSION,provenance:'synthetic',permittedForTraining:true,values:{duration_ms:120000}},occurredAt:at}},leaseId:crypto.randomUUID(),leaseUntil:new Date(now+120000).toISOString(),attempts:1,fitReceipt:{modelVersion:'test:c1:r5',synchronizedFeedbackRevision:5}};
}
function release():PolicyDeliveryLease {
 return {...association(),event:{userId:owner,eventId:crypto.randomUUID(),sequence:2,createdAt:at,kind:'release',request:{userId:owner,requestId:crypto.randomUUID(),exposureId:policyInspection.decision.exposureId,reason:'skip'}},fitReceipt:null};
}
const receipt=(input:PolicyAssociationRequest):PolicyAssociationReceipt=>({userId:input.userId,eventId:input.event.eventId,sequence:input.event.sequence,recordedAt:at,duplicate:false,fitReceipt:structuredClone(input.fitReceipt),eligibleForLearning:false});
const missing=()=>new MlClientError('POLICY_EXPOSURE_NOT_FOUND',404,false);
function fixture(initial=association()) {
 const pending:PolicyDeliveryLease[]=[initial],acks:PolicyDeliveryAck[]=[],retries:Parameters<PolicyStore['retryPolicyDelivery']>[0][]=[],errors:string[]=[],requests:PolicyAssociationRequest[]=[];
 let claims=0;
 const store:Pick<PolicyStore,'claimPolicyDelivery'|'acknowledgePolicyDelivery'|'retryPolicyDelivery'>={
  claimPolicyDelivery:async()=>{claims++;return structuredClone(pending.shift()??null);},
  acknowledgePolicyDelivery:async input=>{acks.push(structuredClone(input));return true;},
  retryPolicyDelivery:async input=>{retries.push(structuredClone(input));return true;},
 };
 const client:Pick<PolicyClient,'associate'|'release'|'exposure'>={
  associate:async input=>{requests.push(structuredClone(input));return receipt(input);},
  release:async input=>({userId:input.userId,requestId:input.requestId,exposureId:input.exposureId,trackId:'demo:track',outcome:'released',recordedAt:at,expiresAt:new Date(now+300000).toISOString(),effectiveClosedAt:at}),
  exposure:async()=>structuredClone(policyInspection),
 };
 const worker=(options:ConstructorParameters<typeof PolicyDeliveryWorker>[2]={})=>new PolicyDeliveryWorker(store,client,{now:()=>now,onError:code=>errors.push(code),...options});
 return {initial,pending,acks,retries,errors,requests,store,client,worker,claims:()=>claims};
}

test('acknowledges immutable committed associations including coalesced inactive history, Skip and revoke',async()=>{
 for(const kind of ['strong','skip','revoke'] as const){
  const f=fixture();if(f.initial.event.kind!=='associate')throw Error('fixture');
  if(kind!=='strong')f.initial.event.event.label=null;
  if(kind==='revoke')f.initial.event.event.operation='revoke';
  const worker=f.worker();expect(await worker.runOnce()).toBe(true);
  expect(f.acks).toEqual([{userId:owner,eventId:f.initial.event.eventId,leaseId:f.initial.leaseId,kind:'associate',receipt:receipt(f.requests[0]!)}]);
  expect(f.requests[0]!.event).toEqual(f.initial.event.event);expect(f.requests[0]!.fitReceipt.synchronizedFeedbackRevision).toBe(5);
  expect(f.retries).toHaveLength(0);expect(await worker.runOnce()).toBe(false);
 }
});

test('bad nested identity, missing/insufficient fit and non-cleanup events cannot reach ML',async()=>{
 for(const mutate of [
  (l:PolicyDeliveryLease)=>{l.fitReceipt=null;},
  (l:PolicyDeliveryLease)=>{l.fitReceipt!.synchronizedFeedbackRevision=3;},
  (l:PolicyDeliveryLease)=>{if(l.event.kind==='associate')l.event.event.sequence=2;},
  (l:PolicyDeliveryLease)=>{if(l.event.kind==='associate')l.event.event.eventId=crypto.randomUUID();},
  (l:PolicyDeliveryLease)=>{if(l.event.kind==='associate')(l.event.event as unknown as {source:string}).source='calibration';},
 ]){
  const f=fixture();mutate(f.initial);await f.worker().runOnce();expect(f.requests).toHaveLength(0);expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 }
 const f=fixture(release());if(f.initial.event.kind==='release')f.initial.event.request.userId='demo:foreign';
 f.client.release=async()=>{throw Error('must not deliver');};await f.worker().runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
});

test('injected clients cannot acknowledge wrong association identity, fit pin or invented rewards',async()=>{
 for(const change of [
  {userId:'demo:foreign'},{eventId:crypto.randomUUID()},{sequence:2},{fitReceipt:{modelVersion:'wrong',synchronizedFeedbackRevision:5}},
  {fitReceipt:{modelVersion:'test:c1:r5',synchronizedFeedbackRevision:6}},{duplicate:'invalid'},
 ]){
  const f=fixture();f.client.associate=async request=>({...receipt(request),...change}) as PolicyAssociationReceipt;
  await f.worker().runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 }
 for(const kind of ['skip','revoke','unpermitted']){
  const f=fixture();if(f.initial.event.kind!=='associate')throw Error('fixture');
  if(kind==='unpermitted')f.initial.event.event.features.permittedForTraining=false;
  else {f.initial.event.event.label=null;if(kind==='revoke')f.initial.event.event.operation='revoke';}
  f.client.associate=async request=>({...receipt(request),eligibleForLearning:true});
  await f.worker().runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 }
});

test('response loss retries identical event with a newer claimed fit receipt and never stores raw errors',async()=>{
 const f=fixture(),worker=f.worker();
 f.client.associate=async request=>{f.requests.push(structuredClone(request));throw Error('private bearer payload');};
 await worker.runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toEqual([{userId:owner,eventId:f.initial.event.eventId,leaseId:f.initial.leaseId,retryAt:new Date(now+30000).toISOString(),errorCode:'POLICY_DELIVERY_RETRY'}]);
 const next=structuredClone(f.initial);next.leaseId=crypto.randomUUID();next.attempts=2;next.fitReceipt={modelVersion:'test:c1:r7',synchronizedFeedbackRevision:7};f.pending.push(next);
 f.client.associate=async request=>{f.requests.push(structuredClone(request));return {...receipt(request),duplicate:true};};
 await worker.runOnce();expect(f.requests[0]!.event).toEqual(f.requests[1]!.event);expect(f.requests[1]!.fitReceipt).toEqual(next.fitReceipt);
 expect(f.acks[0]).toMatchObject({leaseId:next.leaseId,receipt:{duplicate:true,fitReceipt:next.fitReceipt}});expect(JSON.stringify([f.errors,f.retries])).not.toContain('private');
});

test('STALE_FIT_RECEIPT409 retries the immutable event using the next claim receipt without training',async()=>{
 const f=fixture(),worker=f.worker();let trainingCalls=0;
 // Deliberately present forbidden capabilities: delivery must use neither one.
 Object.assign(f.client,{fit:async()=>{trainingCalls++;throw Error('must not fit');},observe:async()=>{trainingCalls++;throw Error('must not observe');}});
 f.client.associate=async request=>{
  f.requests.push(structuredClone(request));
  if(f.requests.length===1)throw new MlClientError('STALE_FIT_RECEIPT',409,false);
  return receipt(request);
 };
 await worker.runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 const next=structuredClone(f.initial);next.leaseId=crypto.randomUUID();next.attempts=2;
 next.fitReceipt={modelVersion:'test:c1:r8',synchronizedFeedbackRevision:8};f.pending.push(next);
 await worker.runOnce();
 expect(f.requests).toHaveLength(2);expect(f.requests[0]!.event).toEqual(f.requests[1]!.event);
 expect(f.requests[0]!.fitReceipt).toEqual({modelVersion:'test:c1:r5',synchronizedFeedbackRevision:5});
 expect(f.requests[1]!.fitReceipt).toEqual({modelVersion:'test:c1:r8',synchronizedFeedbackRevision:8});
 expect(f.acks).toHaveLength(1);expect(f.acks[0]).toMatchObject({eventId:f.initial.event.eventId,leaseId:next.leaseId,receipt:{fitReceipt:next.fitReceipt}});
 expect(f.retries).toHaveLength(1);expect(trainingCalls).toBe(0);
});

test('late responses cannot acknowledge after timeout; stale acknowledgements never retry another lease',async()=>{
 const f=fixture();let complete!:(value:PolicyAssociationReceipt)=>void;
 f.client.associate=request=>new Promise(resolve=>{complete=()=>resolve(receipt(request));});
 await f.worker({timeoutMs:5}).runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 complete({} as PolicyAssociationReceipt);await Bun.sleep(1);expect(f.acks).toHaveLength(0);
 const g=fixture();g.store.acknowledgePolicyDelivery=async()=>false;await g.worker().runOnce();expect(g.retries).toHaveLength(0);expect(g.errors).toContain('POLICY_DELIVERY_LEASE_LOST');
});

test('release requires matching coherent provider receipt and does not require a fit',async()=>{
 const f=fixture(release());await f.worker().runOnce();expect(f.acks[0]).toMatchObject({kind:'release',userId:owner,eventId:f.initial.event.eventId});expect(f.requests).toHaveLength(0);
 for(const change of [{userId:'demo:foreign'},{requestId:crypto.randomUUID()},{exposureId:crypto.randomUUID()},{effectiveClosedAt:new Date(now+400000).toISOString()}]){
  const g=fixture(release()),valid=g.client.release;g.client.release=async input=>({...await valid(input),...change}) as PolicyReleaseReceipt;
  await g.worker().runOnce();expect(g.acks).toHaveLength(0);expect(g.retries).toHaveLength(1);
 }
});

test('release404 needs fresh exact inspection404; only D decides whether absence can settle',async()=>{
 const f=fixture(release());let inspections=0;
 f.client.release=async()=>{throw missing();};f.client.exposure=async query=>{inspections++;expect(query).toEqual({userId:owner,exposureId:policyInspection.decision.exposureId});throw missing();};
 await f.worker().runOnce();expect(inspections).toBe(1);expect(f.acks).toEqual([{kind:'release_absent',userId:owner,eventId:f.initial.event.eventId,leaseId:f.initial.leaseId,exposureId:policyInspection.decision.exposureId,providerStatus:404,checkedAt:at}]);
 const g=fixture(release());g.client.release=async()=>{throw missing();};g.client.exposure=async()=>{throw missing();};g.store.acknowledgePolicyDelivery=async()=>{throw Error('not yet past original deadline');};
 await g.worker().runOnce();expect(g.retries).toHaveLength(1);
});

test('found, foreign, unavailable or hanging inspections never fabricate absent acknowledgement',async()=>{
 for(const inspect of [async()=>structuredClone(policyInspection),async()=>({...structuredClone(policyInspection),decision:{...policyInspection.decision,userId:'demo:foreign'}}),async()=>{throw new MlClientError('POLICY_STATE_UNAVAILABLE',503,true);},async()=>new Promise<never>(()=>{})]){
  const f=fixture(release());f.client.release=async()=>{throw missing();};f.client.exposure=inspect;
  await f.worker({timeoutMs:5}).runOnce();expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
 }
 const f=fixture(release());let inspections=0;f.client.release=async()=>{throw new MlClientError('POLICY_STATE_UNAVAILABLE',503,true);};f.client.exposure=async()=>{inspections++;throw missing();};await f.worker().runOnce();expect(inspections).toBe(0);expect(f.acks).toHaveLength(0);
});

test('client mutation cannot rewrite the acknowledgement identity or the next retry payload',async()=>{
 const f=fixture();f.client.associate=async input=>{input.event.eventId=crypto.randomUUID();return receipt(input);};
 await f.worker().runOnce();expect(f.acks).toHaveLength(0);expect(f.retries[0]!.eventId).toBe(f.initial.event.eventId);
});

test('start and kick coalesce; close drains current work and prevents another claim',async()=>{
 const f=fixture();let entered!:()=>void,finish!:()=>void;
 const begun=new Promise<void>(resolve=>{entered=resolve;}),wait=new Promise<void>(resolve=>{finish=resolve;});
 f.client.associate=async input=>{entered();await wait;return receipt(input);};
 f.pending.push(association());const worker=f.worker();worker.start();worker.start();worker.kick();await begun;
 const closed=worker.close();finish();await closed;worker.kick();await Bun.sleep(1);
 expect(f.claims()).toBe(1);expect(f.acks).toHaveLength(1);expect(f.pending).toHaveLength(1);
});

test('unsafe timer budgets are rejected and claim failures expose only a fixed code',async()=>{
 const f=fixture();for(const options of [{timeoutMs:0},{timeoutMs:NaN},{leaseMs:1000,timeoutMs:1000},{leaseMs:120001},{pollMs:0},{retryMs:Infinity}])expect(()=>f.worker(options)).toThrow();
 f.store.claimPolicyDelivery=async()=>{throw Error('secret database address');};const worker=f.worker();worker.kick();await worker.close();expect(f.errors).toEqual(['POLICY_DELIVERY_UNAVAILABLE']);
});

test('invalid or already expired outer lease cannot address a provider or another durable event',async()=>{
 for(const mutate of [
  (lease:PolicyDeliveryLease)=>{lease.event.eventId='invalid';},
  (lease:PolicyDeliveryLease)=>{lease.event.userId='foreign/invalid';},
  (lease:PolicyDeliveryLease)=>{lease.leaseId='invalid';},
  (lease:PolicyDeliveryLease)=>{lease.leaseUntil=at;},
 ]){
  const f=fixture();mutate(f.initial);await f.worker().runOnce();
  expect(f.requests).toHaveLength(0);expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(0);expect(f.errors).toEqual(['POLICY_DELIVERY_INVALID_LEASE']);
 }
});

test('close is bounded even when claiming or retry persistence hangs; diagnostics cannot break recovery',async()=>{
 const f=fixture();f.store.claimPolicyDelivery=()=>new Promise(()=>{});const worker=f.worker({timeoutMs:5});worker.start();await worker.close();expect(f.errors).toEqual(['POLICY_DELIVERY_UNAVAILABLE']);
 const g=fixture();g.client.associate=async()=>{throw Error('private');};g.store.retryPolicyDelivery=()=>new Promise(()=>{});
 const other=g.worker({timeoutMs:5});other.kick();await other.close();expect(g.errors).toEqual(['POLICY_DELIVERY_RETRY','POLICY_DELIVERY_UNAVAILABLE']);
 const h=fixture();h.client.associate=async()=>{throw Error('private');};await h.worker({onError(){throw Error('diagnostic failure');}}).runOnce();expect(h.retries).toHaveLength(1);
});

test('release error status alone is insufficient evidence to inspect or declare absence',async()=>{
 const f=fixture(release());let inspections=0;
 f.client.release=async()=>{throw Object.assign(Error('private'),{code:'POLICY_EXPOSURE_NOT_FOUND',status:404});};
 f.client.exposure=async()=>{inspections++;throw missing();};await f.worker().runOnce();
 expect(inspections).toBe(0);expect(f.acks).toHaveLength(0);expect(f.retries).toHaveLength(1);
});

test('release replay after a clock rollback acknowledges original terminal time without rewriting it',async()=>{
 const f=fixture(release()),send=f.client.release;
 f.client.release=async input=>({...await send(input),outcome:'already_closed',recordedAt:new Date(now-60000).toISOString()});
 await f.worker().runOnce();expect(f.acks).toHaveLength(1);expect(f.retries).toHaveLength(0);
 expect(f.acks[0]).toMatchObject({kind:'release',receipt:{recordedAt:new Date(now-60000).toISOString(),effectiveClosedAt:at}});
});
