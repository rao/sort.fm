import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type PolicyAssociationRequest,type PolicyAssociationReceipt} from '@sortfm/contracts';
import {createPolicyClient,MlClientError} from '../../ml/client';

const owner='spotify:policy-owner';
const eventId='10000000-0000-4000-8000-000000000001';
const exposureId='20000000-0000-4000-8000-000000000001';
const at='2026-11-07T12:00:00Z';
const association:PolicyAssociationRequest={userId:owner,event:{eventId,sequence:1,source:'cleanup',
  decisionId:'30000000-0000-4000-8000-000000000001',exposureId,trackId:'0000000000000000000001',
  policyVersion:'test-policy-v1',modelVersion:'c1-r3',operation:'upsert',feedbackRevision:4,label:1,
  features:{featureVersion:FEATURE_VERSION,provenance:'spotify',permittedForTraining:true,values:{duration_ms:120000}},occurredAt:at,
},fitReceipt:{modelVersion:'c1-r5',synchronizedFeedbackRevision:5}};
const receipt:PolicyAssociationReceipt={userId:owner,eventId,sequence:1,recordedAt:at,duplicate:false,
  fitReceipt:association.fitReceipt,eligibleForLearning:false};

test('policy association sends only the immutable committed event and refreshable fit receipt',async()=>{
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const client=createPolicyClient({serviceUrl:'https://ml.example.test/internal/',sharedSecret:'test-private-secret',fetch:async(input,init)=>{
    calls.push({url:String(input),init});return Response.json(receipt);
  }});
  expect(await client.associate(association)).toEqual(receipt);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://ml.example.test/internal/policy/associate');
  expect(calls[0]!.init).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer test-private-secret'}});
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual(association);
});

test('policy association refuses foreign or inconsistent acknowledgements',async()=>{
  for(const response of [
    {...receipt,userId:'spotify:other'}, {...receipt,eventId:crypto.randomUUID()}, {...receipt,sequence:2},
    {...receipt,fitReceipt:{...receipt.fitReceipt,modelVersion:'wrong-version'}},
    {...receipt,fitReceipt:{...receipt.fitReceipt,synchronizedFeedbackRevision:6}},
  ]) {
    const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>Response.json(response)});
    await expect(client.associate(association)).rejects.toMatchObject({code:'ML_INVALID_RESPONSE'});
  }
});

test('policy transport sanitizes failures and never automatically retries ambiguous delivery',async()=>{
  let calls=0;
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>{
    calls++;throw new Error('test-private-secret raw provider response');
  }});
  try {await client.associate(association);throw new Error('expected failure');}
  catch(error) {
    expect(error).toBeInstanceOf(MlClientError);expect(error).toMatchObject({code:'ML_UNAVAILABLE',retryable:true});
    expect(String(error)).not.toContain('test-private-secret');expect(JSON.stringify(error)).not.toContain('raw provider');
  }
  expect(calls).toBe(1);
});

test('association request validation prevents insufficient receipts or calibration events from reaching ML',async()=>{
  let calls=0;
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>{calls++;return Response.json(receipt);}});
  for(const request of [
    {...association,fitReceipt:{modelVersion:'old',synchronizedFeedbackRevision:3}},
    {...association,event:{...association.event,source:'calibration'}},
    {...association,event:{...association.event,operation:'revoke',label:1}},
  ]) await expect(client.associate(request as PolicyAssociationRequest)).rejects.toMatchObject({code:'ML_INVALID_REQUEST'});
  expect(calls).toBe(0);
});

test('policy delivery deadline includes a body reader that ignores abort',async()=>{
  let signal:AbortSignal|null|undefined;
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',timeoutMs:5,
    fetch:async(_input,init)=>{signal=init?.signal;return {ok:true,status:200,json:()=>new Promise(()=>{})} as Response;},
  });
  await expect(client.associate(association)).rejects.toMatchObject({code:'ML_TIMEOUT',retryable:true});
  expect(signal?.aborted).toBe(true);
});

test('association response loss can retry the same event under a newer fit receipt',async()=>{
  const requests:unknown[]=[];
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async(_input,init)=>{
    const request=JSON.parse(String(init?.body)) as PolicyAssociationRequest;requests.push(request);
    if(requests.length===1)throw new Error('response lost after commit');
    return Response.json({...receipt,duplicate:true,fitReceipt:request.fitReceipt});
  }});
  await expect(client.associate(association)).rejects.toMatchObject({code:'ML_UNAVAILABLE'});
  const next={...association,fitReceipt:{modelVersion:'c1-r6',synchronizedFeedbackRevision:6}};
  expect(await client.associate(next)).toMatchObject({duplicate:true,fitReceipt:next.fitReceipt});
  expect((requests[0] as PolicyAssociationRequest).event).toEqual((requests[1] as PolicyAssociationRequest).event);
});

import {policyRequest,policyDecision,policyInspection} from './fixtures';

test('policy select pins the exact classifier revision and preserves policy quantities separately',async()=>{
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async(input,init)=>{
    expect(String(input)).toBe('https://ml.example.test/policy/select');
    expect(JSON.parse(String(init?.body))).toEqual(policyRequest);return Response.json(policyDecision);
  }});
  const result=await client.select(policyRequest);
  expect(result.prediction.removalProbability).toBe(0.6);expect(result.selection.uncertainty).toBe(1.4);
});

test('integration select rejects unpinned models before sending and mismatched immutable responses',async()=>{
  let calls=0;
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>{calls++;return Response.json(policyDecision);}});
  await expect(client.select({...policyRequest,modelVersion:null})).rejects.toMatchObject({code:'ML_INVALID_REQUEST'});
  const {feedbackRevision:_revision,...unpinned}=policyRequest;
  await expect(client.select(unpinned)).rejects.toMatchObject({code:'ML_INVALID_REQUEST'});
  expect(calls).toBe(0);
  for(const response of [
    {...policyDecision,userId:'demo:other'}, {...policyDecision,exposureId:crypto.randomUUID()},
    {...policyDecision,feedbackRevision:4}, {...policyDecision,seed:43},
    {...policyDecision,config:{...policyDecision.config,alpha:1}},
    {...policyDecision,candidate:{...policyDecision.candidate,features:{...policyDecision.candidate.features,values:{duration_ms:120001}}}},
    {...policyDecision,candidate:{...policyDecision.candidate,artistIds:['demo:other-artist']}},
    {...policyDecision,candidateCount:2,candidateTrackIds:['demo:track','demo:unrequested']},
  ]) {
    const bad=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>Response.json(response)});
    await expect(bad.select(policyRequest)).rejects.toMatchObject({code:'ML_INVALID_RESPONSE'});
  }
});

test('inspection is scoped to the requested owner and exposure including reservation identity',async()=>{
  for(const value of [policyInspection,{...policyInspection,reservation:{...policyInspection.reservation,exposureId:crypto.randomUUID()}}]) {
    const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async input=>{
      const url=new URL(String(input));expect(url.pathname).toBe('/policy/exposure');
      expect(url.searchParams.get('userId')).toBe(policyRequest.userId);
      expect(url.searchParams.get('exposureId')).toBe(policyRequest.exposureId);return Response.json(value);
    }});
    const response=client.exposure({userId:policyRequest.userId,exposureId:policyRequest.exposureId});
    if(value===policyInspection)expect(await response).toEqual(policyInspection);
    else await expect(response).rejects.toMatchObject({code:'ML_INVALID_RESPONSE'});
  }
});

test('release preserves stable identity and rejects foreign acknowledgement',async()=>{
  const request={userId:owner,requestId:crypto.randomUUID(),exposureId,reason:'prefetch_discarded' as const};
  const result={userId:owner,requestId:request.requestId,exposureId,trackId:'0000000000000000000001',outcome:'released' as const,
    recordedAt:at,expiresAt:'2026-11-07T12:05:00Z',effectiveClosedAt:at};
  for(const value of [result,{...result,requestId:crypto.randomUUID()},{...result,exposureId:crypto.randomUUID()},{...result,userId:'spotify:other'}]) {
    const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async(input,init)=>{
      expect(String(input)).toBe('https://ml.example.test/policy/release');expect(JSON.parse(String(init?.body))).toEqual(request);
      return Response.json(value);
    }});
    if(value===result)expect(await client.release(request)).toEqual(result);
    else await expect(client.release(request)).rejects.toMatchObject({code:'ML_INVALID_RESPONSE'});
  }
});


test('Skip, Undo and unpermitted feature receipts cannot claim a learned reward',async()=>{
  const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>Response.json({...receipt,eligibleForLearning:true})});
  for(const event of [
    {...association.event,label:null}, {...association.event,operation:'revoke' as const,label:null},
    {...association.event,features:{...association.event.features,permittedForTraining:false}},
  ]) await expect(client.associate({...association,event})).rejects.toMatchObject({code:'ML_INVALID_RESPONSE'});
});

test('policy error codes remain classifiable without exposing upstream text',async()=>{
  for(const [status,code,retryable] of [[404,'POLICY_EXPOSURE_NOT_FOUND',false],[409,'NO_ELIGIBLE_CANDIDATES',false],[409,'STALE_FIT_RECEIPT',false],[503,'POLICY_STATE_UNAVAILABLE',true]] as const) {
    const client=createPolicyClient({serviceUrl:'https://ml.example.test',sharedSecret:'test-private-secret',fetch:async()=>Response.json({code,message:'test-private-secret',retryable},{status})});
    await expect(client.associate(association)).rejects.toMatchObject({code,status,retryable});
  }
});
