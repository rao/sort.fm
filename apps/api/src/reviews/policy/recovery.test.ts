import {expect,test} from 'bun:test';
import type {PolicyStore,SelectionIntent,PublishSelectionInput} from '@sortfm/contracts';
import type {PolicyClient} from '../../ml/client';
import {PolicySelectionRecoveryWorker} from './recovery';
import {policyRequest,policyDecision,policyInspection,policyAt} from './fixtures';
const now=Date.parse(policyAt);
function setup() {
  const intent:SelectionIntent={userId:policyRequest.userId,requestId:crypto.randomUUID(),feedbackRevision:3,membershipRevision:1,
    fingerprint:'immutable',createdAt:policyAt,expiresAt:new Date(now+300000).toISOString(),status:'prepared',
    draft:{kind:'adaptive',queuePolicy:'discovery',request:{...structuredClone(policyRequest),modelVersion:policyRequest.modelVersion!,feedbackRevision:3,config:{...policyRequest.config,strategy:'linucb'}}},
    lease:{leaseId:crypto.randomUUID(),leaseUntil:new Date(now+60000).toISOString()},publication:null,replayable:false,servableExposureIds:[]};
  const published:PublishSelectionInput[]=[],releases:unknown[]=[],selected:unknown[]=[];let pending=true;
  const store:Pick<PolicyStore,'claimSelectionRecovery'|'publishSelection'|'releaseSelection'>={
    claimSelectionRecovery:async()=>pending?(pending=false,structuredClone(intent)):null,
    publishSelection:async input=>{published.push(input);return {outcome:'rejected',reason:'lease_lost',intent};},
    releaseSelection:async input=>{releases.push(input);return {...input,recordedAt:policyAt,outcome:'release_pending'};},
  };
  const client:Pick<PolicyClient,'select'|'exposure'>={select:async request=>{selected.push(structuredClone(request));return structuredClone(policyDecision);},exposure:async()=>structuredClone(policyInspection)};
  return {intent,store,client,published,releases,selected};
}
test('recovery replays the original selection request and preference unchanged then uses its new lease fence',async()=>{
  const s=setup(),worker=new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now});
  expect(await worker.runOnce()).toBe(true);expect(await worker.runOnce()).toBe(false);
  expect(s.selected).toEqual([policyRequest]);expect(s.published).toHaveLength(1);
  expect(s.published[0]).toMatchObject({leaseId:s.intent.lease!.leaseId,requestId:s.intent.requestId,kind:'adaptive'});
  if(s.published[0]!.kind==='adaptive')expect(s.published[0]!.item.exposure.policy).toBe('discovery');
  expect(s.releases).toHaveLength(0); // Lost publish lease cannot close a newer attempt.
});
test('expired recovery never starts remote selection and abandons only with its execution fence',async()=>{
  const s=setup();s.intent.expiresAt=policyAt;
  await new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now}).runOnce();
  expect(s.selected).toHaveLength(0);expect(s.published).toHaveLength(0);
  expect(s.releases[0]).toMatchObject({expectedLeaseId:s.intent.lease!.leaseId,reason:'abandoned'});
});
test('hung recovery is bounded and queues durable release without publishing late results',async()=>{
  const s=setup();let finish:((value:typeof policyDecision)=>void)|undefined;
  s.client.select=()=>new Promise(resolve=>{finish=resolve;});
  await new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now,timeoutMs:5}).runOnce();
  expect(s.releases).toHaveLength(1);expect(s.published).toHaveLength(0);
  finish?.(structuredClone(policyDecision));await Bun.sleep(1);
  expect(s.published).toHaveLength(0);
});
test('recovery stop drains active work and rejects unsafe deadlines',async()=>{
  const s=setup();const worker=new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now});
  worker.start();await worker.close();expect(s.published).toHaveLength(1);
  expect(()=>new PolicySelectionRecoveryWorker(s.store,s.client,{timeoutMs:60000,leaseMs:60000})).toThrow();
});

test('hung publication cannot block worker shutdown and diagnostics cannot prevent fenced recovery',async()=>{
  const s=setup();s.store.publishSelection=()=>new Promise(()=>{});
  const worker=new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now,timeoutMs:5,onError:()=>{throw new Error('logger failed');}});
  const completed=await Promise.race([worker.runOnce().then(()=>true),Bun.sleep(40).then(()=>false)]);
  expect(completed).toBe(true);expect(s.releases).toHaveLength(1);
});

import {abandonSelection} from './selection';
test('repeated abandonment of one execution fence preserves the release command identity',async()=>{
  const s=setup();await abandonSelection(s.store,s.intent);await abandonSelection(s.store,s.intent);
  expect(s.releases[0]).toEqual(s.releases[1]);
});

test('backward wall-clock movement does not invalidate an inspected active reservation or renew its expiry',async()=>{
  const s=setup();await new PolicySelectionRecoveryWorker(s.store,s.client,{now:()=>now-1000}).runOnce();
  expect(s.published).toHaveLength(1);expect(s.releases).toHaveLength(0);
  expect(s.published[0]).toMatchObject({kind:'adaptive',providerExpiresAt:policyInspection.reservation.expiresAt});
});
