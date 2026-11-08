import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type PolicyStore,type SelectionIntent,type ReviewCandidateSnapshot,type ExposureInput,type PolicyDecision} from '@sortfm/contracts';
import {PolicyQueueService} from './queue';
import type {PolicyClient} from '../../ml/client';
import {policyDecision,policyAt} from './fixtures';
const now=Date.parse(policyAt),owner='spotify:owner';
const id=(n:number)=>String(n).padStart(22,'0');
function setup() {
  const snapshot:ReviewCandidateSnapshot={library:[1,2,3].map(n=>({track:{trackId:id(n),spotifyUri:`spotify:track:${id(n)}`,source:'spotify',title:`Fixture ${n}`,artists:[{id:'artist',name:'Artist'}],album:'',imageUrl:null,durationMs:120000,explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true},currentStatus:'saved',audioFeatures:null,currentDecision:null})),
    eligibleTrackIds:[id(1),id(3)],remaining:2,feedbackRevision:3,membershipRevision:1,fitReceipt:{modelVersion:'test:c1:r3',synchronizedFeedbackRevision:3}};
  const intents:SelectionIntent[]=[],released:unknown[]=[],published:unknown[]=[];
  let current:SelectionIntent|null=null;
  const store:Pick<PolicyStore,'currentSelection'|'reviewCandidates'|'prepareSelection'|'publishSelection'|'releaseSelection'>={
    currentSelection:async()=>current,reviewCandidates:async()=>structuredClone(snapshot),
    prepareSelection:async input=>{
      const intent:SelectionIntent={...input,fingerprint:'test',createdAt:policyAt,expiresAt:new Date(now+300000).toISOString(),status:'prepared',lease:{leaseId:crypto.randomUUID(),leaseUntil:new Date(now+60000).toISOString()},publication:null,replayable:false,servableExposureIds:[]};
      intents.push(intent);return {outcome:'claimed',intent:intent as SelectionIntent&{lease:NonNullable<SelectionIntent['lease']>}};
    },
    publishSelection:async input=>{
      published.push(input);const intent=intents.find(row=>row.requestId===input.requestId)!;
      const items=input.kind==='adaptive'?[input.item]:intent.draft.kind==='c1'?intent.draft.items:[];
      intent.publication={items,policyDecision:input.kind==='adaptive'?input.decision:null,publishedAt:policyAt,reservations:[]};
      intent.status='published';intent.replayable=true;intent.servableExposureIds=items.map(x=>x.exposure.exposureId);current=intent;
      return {outcome:'published',intent:intent as SelectionIntent&{publication:NonNullable<SelectionIntent['publication']>}};
    },
    releaseSelection:async input=>{released.push(input);current=null;return {...input,recordedAt:policyAt,outcome:'release_pending'};},
  };
  const requests:unknown[]=[],decisions=new Map<string,PolicyDecision>();
  const client:PolicyClient={
    select:async request=>{
      expect(intents.some(i=>i.draft.kind==='adaptive'&&i.draft.request.exposureId===request.exposureId)).toBe(true);
      requests.push(structuredClone(request));const candidate=request.candidates[0]!;
      const decision:PolicyDecision={...structuredClone(policyDecision),userId:owner,exposureId:request.exposureId,trackId:candidate.trackId,candidate,
        seed:request.seed,config:request.config,modelVersion:request.modelVersion!,feedbackRevision:request.feedbackRevision,
        selection:{...policyDecision.selection,trackId:candidate.trackId,greedyTrackId:candidate.trackId,selectionMethod:request.config.strategy},
        candidateTrackIds:request.candidates.map(c=>c.trackId),candidateCount:request.candidates.length,availableCount:request.candidates.length};
      decisions.set(request.exposureId,decision);return decision;
    },
    exposure:async query=>({decision:decisions.get(query.exposureId)!,feedback:[],eligibility:null,reservation:{exposureId:query.exposureId,reservedAt:policyAt,expiresAt:new Date(now+300000).toISOString(),evaluatedAt:policyAt,status:'active',closedAt:null,closureReason:null}}),
    associate:async()=>{throw new Error('Queue must not associate');},release:async()=>{throw new Error('Queue releases through durable store');},
  };
  return {store,snapshot,intents,published,released,requests,client,current:()=>current};
}
const query={limit:20,policy:'balanced' as const,mode:'spotify' as const};
test('default C1 uses common eligibility and atomic publication with no policy network calls',async()=>{
  const s=setup();const queue=new PolicyQueueService(s.store,{now:()=>now,client:s.client});
  const result=await queue.get(owner,query);
  expect(result.items.map(i=>i.track.trackId)).toEqual([id(1),id(3)]);
  expect(s.requests).toHaveLength(0);expect(s.published).toHaveLength(1);expect(s.intents[0]!.draft.kind).toBe('c1');
  expect(result.remaining).toBe(2);
});
for(const strategy of ['epsilon_greedy','linucb'] as const)test(`${strategy} selects one item from identical eligible pool and freezes separate policy telemetry`,async()=>{
  const s=setup();const queue=new PolicyQueueService(s.store,{now:()=>now,enabled:true,strategy,client:s.client});
  const result=await queue.get(owner,query);
  expect(result.items).toHaveLength(1);expect(result.items[0]!.track.trackId).toBe(id(1));
  expect(result.items[0]!.exposure.selectionMethod).toBe(strategy);
  expect(result.items[0]!.exposure.uncertainty).toBe(0.7);expect(result.items[0]!.exposure.policyTelemetry?.uncertainty).toBe(1.4);
  expect((s.requests[0] as {candidates:{trackId:string}[]}).candidates.map(c=>c.trackId)).toEqual([id(1),id(3)]);
  expect(s.published).toHaveLength(1);expect(result.remaining).toBe(2);
});
test('disabled flag and absent fit receipt use C1 without C2 calls',async()=>{
  for(const enabled of [false,true]) {
    const s=setup();if(enabled)s.snapshot.fitReceipt=null;
    const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled,client:s.client}).get(owner,query);
    expect(result.items).toHaveLength(2);expect(s.requests).toHaveLength(0);expect(s.intents[0]!.draft.kind).toBe('c1');
  }
});
test('refresh serves only durable remaining exposure IDs without rescoring or allocating another page',async()=>{
  const s=setup();const queue=new PolicyQueueService(s.store,{now:()=>now});
  const first=await queue.get(owner,query);
  s.current()!.servableExposureIds=[first.items[1]!.exposure.exposureId];s.snapshot.remaining=1;
  const second=await queue.get(owner,query);
  expect(second.items).toEqual([first.items[1]!]);expect(second.remaining).toBe(1);expect(s.intents).toHaveLength(1);
});
test('ambiguous C2 timeout abandons under execution fence and fallback gets fresh unbound IDs',async()=>{
  const s=setup();let attempted:string|undefined;
  s.client.select=async request=>{attempted=request.exposureId;return new Promise(()=>{});};
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client,selectionTimeoutMs:5}).get(owner,query);
  expect(result.items).toHaveLength(2);expect(result.items.every(i=>i.exposure.exposureId!==attempted&&!i.exposure.policyTelemetry)).toBe(true);
  expect(s.released[0]).toMatchObject({expectedLeaseId:s.intents[0]!.lease!.leaseId,reason:'abandoned',exposureIds:[attempted]});
  expect(s.intents[1]!.draft.kind).toBe('c1');expect(result.fallbackReason).toContain('C1');
});
test('stale publication cannot return a policy card and fallback rereads eligibility',async()=>{
  const s=setup();const publish=s.store.publishSelection;
  s.store.publishSelection=async input=>{
    if(input.kind==='adaptive') {s.snapshot.eligibleTrackIds=[id(3)];s.snapshot.remaining=1;return {outcome:'rejected',reason:'candidates_changed',intent:s.intents[0]!};}
    return publish(input);
  };
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
  expect(result.items.map(i=>i.track.trackId)).toEqual([id(3)]);expect(result.items[0]!.exposure.policyTelemetry).toBeUndefined();
});
test('expired and foreign policy responses never publish adaptive exposure',async()=>{
  for(const invalid of ['expired','foreign'] as const) {
    const s=setup();const select=s.client.select,inspect=s.client.exposure;
    if(invalid==='foreign')s.client.select=async request=>({...await select(request),userId:'spotify:other'});
    else s.client.exposure=async request=>({...await inspect(request),reservation:{exposureId:request.exposureId,reservedAt:new Date(now-300000).toISOString(),expiresAt:policyAt,evaluatedAt:policyAt,status:'expired',closedAt:policyAt,closureReason:'expiry'}});
    const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
    expect(result.items.every(i=>!i.exposure.policyTelemetry)).toBe(true);expect(s.intents.at(-1)!.draft.kind).toBe('c1');
  }
});

test('policy switch discards incompatible published prefetch before creating a new selection',async()=>{
  const s=setup();await new PolicyQueueService(s.store,{now:()=>now}).get(owner,query);
  const original=s.current()!;
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'epsilon_greedy',enabled:true,client:s.client}).get(owner,query);
  expect(s.released[0]).toMatchObject({requestId:original.requestId,exposureIds:original.servableExposureIds,reason:'prefetch_discarded'});
  expect(result.items).toHaveLength(1);expect(result.items[0]!.exposure.selectionMethod).toBe('epsilon_greedy');
});
test('fallback page is reused while the same adaptive policy remains unavailable',async()=>{
  const s=setup();s.client.select=async()=>{throw new Error('offline');};
  const queue=new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client});
  const first=await queue.get(owner,query),count=s.intents.length;
  expect(await queue.get(owner,query)).toEqual(first);expect(s.intents).toHaveLength(count);
});
test('model/revision pin and full library context survive filtering and current receipt advancement',async()=>{
  const s=setup();let contextCount=0;
  const queue=new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client,
    assemble:rows=>{contextCount=rows.length;return rows.map(row=>({trackId:row.track.trackId,features:{featureVersion:FEATURE_VERSION,provenance:'spotify',permittedForTraining:false,values:{duration_ms:120000}}}));}});
  await queue.get(owner,query);expect(contextCount).toBe(3);
  expect(s.requests[0]).toMatchObject({modelVersion:'test:c1:r3',feedbackRevision:3});
  s.snapshot.fitReceipt={modelVersion:'test:c1:r4',synchronizedFeedbackRevision:4};
  const replay=await queue.get(owner,query);expect(replay.items[0]!.prediction.modelVersion).toBe('test:c1:r3');expect(s.requests).toHaveLength(1);
});
test('C1 publication conflict and missing durable publication cannot return an uncommitted page',async()=>{
  const s=setup();s.store.publishSelection=async()=>({outcome:'rejected',reason:'candidates_changed',intent:s.intents[0]!});
  await expect(new PolicyQueueService(s.store,{now:()=>now}).get(owner,query)).rejects.toMatchObject({code:'QUEUE_CHANGED'});
});

test('genuine C2 cold-start C1 choice retains adaptive binding and truthful C1 selection telemetry',async()=>{
  const s=setup(),select=s.client.select,inspect=s.client.exposure;
  s.client.select=async request=>{const d=await select(request);d.selection.selectionMethod='c1';d.trainedRewards=0;return d;};
  s.client.exposure=async request=>{const inspected=await inspect(request);inspected.decision.selection.selectionMethod='c1';inspected.decision.trainedRewards=0;return inspected;};
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
  expect(s.intents).toHaveLength(1);expect(s.intents[0]!.draft.kind).toBe('adaptive');
  expect(s.published[0]).toMatchObject({kind:'adaptive'});
  expect(result.items[0]!.exposure.selectionMethod).toBe('logistic_rank');
  expect(result.items[0]!.exposure.policyTelemetry).toMatchObject({selectionMethod:'c1',trainedRewards:0});
});
test('stale durable fit receipt uses C1 without starting an invalid adaptive intent',async()=>{
  const s=setup();s.snapshot.feedbackRevision=4;
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
  expect(s.requests).toHaveLength(0);expect(s.intents[0]!.draft.kind).toBe('c1');expect(result.fallbackReason).toContain('C1');
});

test('C1 default and fallback discover the current classifier independently of a stale optional policy receipt',async()=>{
  for(const strategy of ['c1','linucb'] as const) {
    const s=setup();s.snapshot.feedbackRevision=4;const versions:(string|null|undefined)[]=[];
    const result=await new PolicyQueueService(s.store,{now:()=>now,strategy,enabled:true,client:s.client,
      score:async(userId,candidates,version)=>{versions.push(version);return {userId,featureVersion:FEATURE_VERSION,modelVersion:'test:c1:r4',
        predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...policyDecision.prediction,modelVersion:'test:c1:r4'}}))};},
    }).get(owner,query);
    expect(versions).toEqual([null,'test:c1:r4']);expect(result.items[0]!.prediction.modelVersion).toBe('test:c1:r4');
  }
});
test('adaptive selection with null classifier probabilities never claims stable library ordering',async()=>{
  const s=setup(),select=s.client.select;
  s.client.select=async request=>{const d=await select(request);d.prediction={...d.prediction,modelKind:'heuristic',removalProbability:null,heuristicScore:0.6,calibrated:false};return d;};
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
  expect(result.items).toHaveLength(1);expect(result.items[0]!.exposure.policyTelemetry).toBeDefined();
  expect(result.fallbackReason??'').not.toContain('stable library order');
});

test('concurrent adaptive preparation does not perform another remote selection or serve an unclaimed card',async()=>{
  const s=setup(),prepare=s.store.prepareSelection;
  s.store.prepareSelection=async input=>{const claimed=await prepare(input);return {outcome:'in_progress',intent:claimed.intent};};
  const result=await new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client}).get(owner,query);
  expect(result.items).toHaveLength(0);expect(s.requests).toHaveLength(0);expect(s.published).toHaveLength(0);
});
test('prepare replay serves only the published servable subset without rerunning selection',async()=>{
  const s=setup();const queue=new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client});
  const first=await queue.get(owner,query),intent=s.current()!;s.store.currentSelection=async()=>null;
  s.store.prepareSelection=async()=>({outcome:'replay',intent:intent as SelectionIntent&{publication:NonNullable<SelectionIntent['publication']>}});
  expect(await queue.get(owner,query)).toEqual(first);expect(s.requests).toHaveLength(1);expect(s.published).toHaveLength(1);
});
test('lost publication response cannot abandon a committed page under an obsolete execution fence',async()=>{
  const s=setup(),publish=s.store.publishSelection;
  s.store.publishSelection=async input=>{await publish(input);throw new Error('commit response lost');};
  s.store.releaseSelection=async input=>{
    s.released.push(input);expect(input.expectedLeaseId).toBe(s.intents[0]!.lease!.leaseId);
    if(s.current()?.status==='published')throw new Error('POLICY_LEASE_LOST');
    return {...input,recordedAt:policyAt,outcome:'release_pending'};
  };
  const queue=new PolicyQueueService(s.store,{now:()=>now,strategy:'linucb',enabled:true,client:s.client});
  await expect(queue.get(owner,query)).rejects.toThrow('POLICY_LEASE_LOST');
  const committed=s.current()!.publication!.items[0]!;
  const next=await queue.get(owner,query);
  expect(next.items[0]!.exposure).toEqual(committed.exposure);expect(s.intents).toHaveLength(1);expect(s.requests).toHaveLength(1);
});

import Fastify from 'fastify';
import {PersistenceError} from '@sortfm/db';
import {createReviewQueueModule} from '../module';
test('a different concurrent prepare returns retryable409 without another select or fallback intent for every strategy',async()=>{
  for(const strategy of ['c1','epsilon_greedy','linucb'] as const) {
    const s=setup();let preparations=0;
    // D throws for a different request ID; in_progress is only a same-ID replay.
    s.store.prepareSelection=async()=>{preparations++;throw new PersistenceError('POLICY_SELECTION_BUSY');};
    const queue=new PolicyQueueService(s.store,{now:()=>now,strategy,enabled:true,client:s.client});
    const app=Fastify();
    await app.register(createReviewQueueModule({queue,
      config:{secureCookies:false,webOrigin:'http://127.0.0.1:5173',apiOrigin:'http://127.0.0.1:3000'},
      auth:{session:async()=>({user:{id:owner}})},
    }).registerRoutes);
    try {
      const response=await app.inject('/api/queue');
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({code:'POLICY_SELECTION_BUSY',message:'A review selection is being prepared. Retry shortly.',retryable:true});
      expect(preparations).toBe(1);expect(s.requests).toHaveLength(0);expect(s.published).toHaveLength(0);expect(s.released).toHaveLength(0);
    } finally {await app.close();}
  }
});
