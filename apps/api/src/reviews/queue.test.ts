import {listeningSnapshot} from './listening-test-fixtures';
import {expect, test} from 'bun:test';
import Fastify from 'fastify';
import {createDemoQueue} from '@sortfm/contracts/fixtures';
import {assembleLibraryCandidates} from '../ml';
import {FEATURE_VERSION, QueueResultSchema, type ExposureInput, type Prediction, type ScoringCandidate, type ScoreResponse} from '@sortfm/contracts';
import {QueueService, type LibraryRow} from './queue';
import {createReviewQueueModule} from './module';

const now = Date.parse('2026-11-07T00:00:00Z');
function row(n: number, status: LibraryRow['currentStatus'] = 'saved'): LibraryRow {
  const id = String(n).padStart(22,'0');
  return {track:{trackId:id,spotifyUri:`spotify:track:${id}`,source:'spotify',title:`Track ${n}`,artists:[{id:null,name:'Artist'}],album:'',imageUrl:null,durationMs:120000,explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true},currentStatus:status,audioFeatures:null,currentDecision:null};
}
function setup(rows = [row(1),row(2)], extra: Partial<ConstructorParameters<typeof QueueService>[1]> = {}) {
  const stored: ExposureInput[] = [], calls: string[] = [];
  const repository = {library:async(userId:string) => {calls.push(userId); return rows;},insertExposure:async(input:ExposureInput) => {stored.push(structuredClone(input));}};
  return {service:new QueueService(repository,{now:()=>now,...extra}),repository,stored,calls};
}
const prediction: Prediction = {modelKind:'logistic',modelVersion:'test:model',featureVersion:FEATURE_VERSION,trainedExamples:30,removalProbability:0.7,heuristicScore:null,uncertainty:0.8,uncertaintyMethod:'entropy',calibrated:false,explanations:[]};

test('cold queue is real data with immutable null-audio snapshots, no fabricated probability', async () => {
  const {service,stored,calls} = setup();
  const result = QueueResultSchema.parse(await service.get('spotify:owner',{limit:1,policy:'balanced',mode:'spotify'}));
  expect(result.items).toHaveLength(1); expect(result.remaining).toBe(2); expect(result.nextCursor).toBeNull();
  expect(calls).toEqual(['spotify:owner']); expect(stored).toHaveLength(1);
  expect(result.items[0]!.prediction).toMatchObject({modelKind:'untrained',removalProbability:null,calibrated:false});
  expect(stored[0]!.exposure).toEqual(result.items[0]!.exposure);
  expect(stored[0]!.features).toMatchObject({featureVersion:FEATURE_VERSION,permittedForTraining:false});
  expect(stored[0]!.features.values.energy).toBeUndefined();
});

test('filters unplayable, synthetic, already kept and in-flight decisions; deferred tracks go last', async () => {
  const rows = [row(1,'kept'),row(2,'deferred'),row(3),row(4),row(5),row(6)];
  rows[3]!.track.isPlayable=false;
  rows[4]!.currentDecision={status:'PENDING'} as LibraryRow['currentDecision'];
  rows[5]!.track={...rows[5]!.track,source:'synthetic',trackId:'demo:6',spotifyUri:null};
  const {service}=setup(rows);
  expect((await service.get('spotify:owner',{limit:20,policy:'discovery',mode:'spotify'})).items.map(x=>x.track.trackId)).toEqual([row(3).track.trackId,row(2).track.trackId]);
});

test('scored snapshot matches persisted features and caller-assigned exposure IDs', async () => {
  const {service,stored} = setup(undefined,{score:async(userId,candidates)=>{
    expect(candidates.every(x=>Boolean(x.exposureId))).toBe(candidates[0]?.exposureId!==undefined);
    return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};
  }});
  const result=await service.get('spotify:owner',{limit:2,policy:'certainty',mode:'spotify'});
  expect(result.items[0]!.prediction).toEqual(prediction); expect(stored[0]!.prediction).toEqual(prediction);
  expect(result.items[0]!.exposure.selectionMethod).toBe('logistic_rank');
});

test('ML failures, wrong owner and incomplete score batches fall back without blocking queue', async () => {
  for(const score of [async()=>{throw new Error('private upstream token');},async()=>({userId:'spotify:other',modelVersion:'m',featureVersion:FEATURE_VERSION,predictions:[]})]) {
    const {service}=setup(undefined,{score}); const result=await service.get('spotify:owner',{limit:2,policy:'balanced',mode:'spotify'});
    expect(result.items).toHaveLength(2); expect(result.fallbackReason).not.toContain('private'); expect(result.items[0]!.prediction.removalProbability).toBeNull();
  }
});

test('does not return a queue when exposure persistence fails', async () => {
  const {repository}=setup(); repository.insertExposure=async()=>{throw new Error('db secret');};
  await expect(new QueueService(repository).get('spotify:owner',{limit:1,policy:'balanced',mode:'spotify'})).rejects.toThrow('db secret');
});

test('route uses server session identity and rejects duplicate cookies, spoofed identity and foreign origin', async () => {
  const {service,calls}=setup();
  const module=createReviewQueueModule({queue:service,config:{secureCookies:false,webOrigin:'http://127.0.0.1:5173',apiOrigin:'http://127.0.0.1:3000'},auth:{session:async token=>token==='valid'?{user:{id:'spotify:owner'}}:null}});
  const app=Fastify(); await app.register(module.registerRoutes);
  try {
    expect((await app.inject('/api/queue')).statusCode).toBe(401);
    expect((await app.inject({url:'/api/queue',headers:{cookie:'sortfm_session=valid; sortfm_session=evil'}})).statusCode).toBe(401);
    expect((await app.inject({url:'/api/queue?userId=other',headers:{cookie:'sortfm_session=valid'}})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/queue',headers:{cookie:'sortfm_session=valid',origin:'https://evil.test'}})).statusCode).toBe(403);
    const result=await app.inject({url:'/api/queue?limit=1',headers:{cookie:'sortfm_session=valid'}});
    expect(result.statusCode).toBe(200); expect(result.headers['cache-control']).toBe('no-store'); expect(calls).toEqual(['spotify:owner']);
    expect((await app.inject({url:'/api/queue?mode=demo'})).statusCode).toBe(404);
  } finally {await app.close();}
});

test('a hung scorer hits a bounded deadline and 2700 tracks remain immediately reviewable', async()=>{
  const {service}=setup(Array.from({length:2700},(_,i)=>row(i+1)),{score:()=>new Promise(()=>{}),scoreTimeoutMs:5});
  const result=await service.get('spotify:owner',{limit:100,policy:'balanced',mode:'spotify'});
  expect(result.items).toHaveLength(100); expect(result.remaining).toBe(2700);
  expect(result.fallbackReason).toContain('unavailable');
});


test('late scorer cannot overwrite a fallback exposure identity or feature snapshot',async()=>{
  let scoredId:string|undefined;
  const {service,stored}=setup([row(1)],{scoreTimeoutMs:1,score:async(userId,candidates)=>{
    if(candidates[0]!.exposureId){
      scoredId=candidates[0]!.exposureId;
      candidates[0]!.features.values.duration_ms=42;
      await new Promise(resolve=>setTimeout(resolve,15));
    }
    return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:[{trackId:candidates[0]!.trackId,prediction}]};
  }});
  const result=await service.get('spotify:owner',{limit:1,policy:'balanced',mode:'spotify'});
  expect(result.items[0]!.exposure.exposureId).not.toBe(scoredId);
  expect(stored[0]!.features.values.duration_ms).toBe(120000);
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(result.items[0]!.prediction.modelKind).toBe('untrained');
});


test('explicit demo injection preserves public fixture queue without reading live accounts',async()=>{
  const {service,calls}=setup();const app=Fastify();
  const module=createReviewQueueModule({queue:service,config:{secureCookies:false,apiOrigin:'http://127.0.0.1:3000',webOrigin:'http://127.0.0.1:5173'},auth:{session:async()=>{throw new Error('Demo must not access sessions');}},demoQueue:query=>createDemoQueue({limit:query.limit,policy:query.policy,exposureId:()=>crypto.randomUUID()})});
  await app.register(module.registerRoutes);
  try {
    const response=await app.inject('/api/queue?mode=demo&limit=2&policy=discovery');
    expect(response.statusCode).toBe(200);expect(QueueResultSchema.parse(response.json())).toMatchObject({mode:'demo'});expect(response.json().items).toHaveLength(2);expect(calls).toHaveLength(0);
  } finally {await app.close();}
});


test('library-derived features include current kept tracks beyond the selected page',async()=>{
  const rows=[row(1),row(2),row(3,'kept'),row(4)];
  for(const row of rows)row.track.artists=[{id:'artist-one',name:'Same artist'}];
  const {service,stored}=setup(rows,{assemble:(rows,ctx)=>assembleLibraryCandidates(rows,{...ctx,now:new Date(ctx.now).toISOString()})});
  const result=await service.get('spotify:owner',{limit:1,policy:'balanced',mode:'spotify'});
  expect(result.items).toHaveLength(1);expect(result.remaining).toBe(3);
  expect(stored[0]!.features.values.artist_library_count).toBe(4);
});


function scores(userId:string,candidates:ScoringCandidate[],version='test:model',probability:(id:string)=>number=()=>0.7):ScoreResponse {
  return {userId,modelVersion:version,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...prediction,modelVersion:version,removalProbability:probability(c.trackId)}}))};
}
const query={limit:2,policy:'balanced' as const,mode:'spotify' as const};

test('ranks the complete eligible pool before slicing; pins only served IDs and preserves deferred eligibility',async()=>{
  const rows=[row(1),row(2),row(3),row(4,'deferred'),row(5,'kept')];
  const calls:{candidates:ScoringCandidate[];version:string|null|undefined}[]=[];
  const {service,stored}=setup(rows,{score:async(user,candidates,version)=>{
    calls.push({candidates:structuredClone(candidates),version});
    return scores(user,candidates,'v1',id=>Number(id)/10);
  }});
  const result=await service.get('spotify:owner',query);
  expect(result.items.map(x=>x.track.trackId)).toEqual([row(3).track.trackId,row(2).track.trackId]);
  expect(result.remaining).toBe(4);expect(result.fallbackReason).toBeNull();
  expect(calls).toHaveLength(2);expect(calls[0]!.candidates).toHaveLength(4);
  expect(calls[0]!.candidates.every(c=>c.exposureId===undefined)).toBe(true);
  expect(calls[1]!.version).toBe('v1');expect(calls[1]!.candidates).toHaveLength(2);
  expect(calls[1]!.candidates.map(c=>c.exposureId)).toEqual(result.items.map(i=>i.exposure.exposureId));
  expect(stored.map(s=>s.exposure)).toEqual(result.items.map(i=>i.exposure));
  expect(result.items[0]!.exposure).toMatchObject({selectionMethod:'logistic_rank',policyVersion:'queue:c1-removal:v1',explorationCoefficient:0,propensityEstimate:null});
});

test('a new committed feedback model changes ordering without altering prior exposure snapshots',async()=>{
  let version='v1';
  const {service,stored}=setup([row(1),row(2),row(3)],{score:async(user,candidates,pinned)=>scores(user,candidates,pinned??version,id=>(pinned??version)==='v1'?Number(id)/10:1-Number(id)/10)});
  const first=await service.get('spotify:owner',query),old=structuredClone(stored);
  version='v2';
  const second=await service.get('spotify:owner',query);
  expect(first.items[0]!.track.trackId).toBe(row(3).track.trackId);
  expect(second.items[0]!.track.trackId).toBe(row(1).track.trackId);
  expect(first.items.every(i=>i.prediction.modelVersion==='v1')).toBe(true);
  expect(second.items.every(i=>i.prediction.modelVersion==='v2')).toBe(true);
  expect(stored.slice(0,2)).toEqual(old);
  expect(new Set(stored.map(s=>s.exposure.exposureId)).size).toBe(4);
});

test('equal scores use age then ID and saved/deferred grouping, independent of repository order',async()=>{
  const rows=[row(3),row(1),row(4,'deferred'),row(2)];
  rows[3]!.track.originalAddedAt='2019-01-01T00:00:00Z';
  const {service}=setup(rows,{score:async(user,candidates)=>scores(user,candidates)});
  const result=await service.get('spotify:owner',{...query,limit:10});
  expect(result.items.map(i=>i.track.trackId)).toEqual([row(2),row(1),row(3),row(4)].map(r=>r.track.trackId));
});

test('cold heuristic scores stay honest and deterministic even when heuristic scores differ',async()=>{
  const {service}=setup([row(2),row(1)],{score:async(user,candidates)=>({...scores(user,candidates),predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...prediction,modelKind:'heuristic',removalProbability:null,heuristicScore:Number(c.trackId)/10,uncertainty:null,uncertaintyMethod:'none'}}))})});
  const result=await service.get('spotify:owner',query);
  expect(result.items.map(i=>i.track.trackId)).toEqual([row(1).track.trackId,row(2).track.trackId]);
  expect(result.fallbackReason).toContain('learned probabilities');
  expect(result.items.every(i=>i.prediction.removalProbability===null&&i.exposure.selectionMethod==='deterministic_baseline')).toBe(true);
});

test('model publication between passes cannot change the pinned selected predictions',async()=>{
  let current='v1';
  const {service}=setup([row(1),row(2)],{score:async(user,candidates,pinned)=>{
    const response=scores(user,candidates,pinned??current,id=>(pinned??current)==='v1'?Number(id)/10:1-Number(id)/10);
    current='v2';return response;
  }});
  const result=await service.get('spotify:owner',query);
  expect(result.items[0]!.track.trackId).toBe(row(2).track.trackId);
  expect(result.items.every(i=>i.prediction.modelVersion==='v1')).toBe(true);
});

test('incoherent keyed responses restore stable order with fresh baseline IDs',async()=>{
  for(const failure of ['version','owner','prediction','duplicate','missing','kind'] as const){
    let keyedIds:string[]=[];
    const {service}=setup([row(2),row(1)],{score:async(user,candidates,pinned)=>{
      const response=scores(user,candidates,pinned??'v1',id=>Number(id)/10);
      if(pinned){
        keyedIds=candidates.map(c=>c.exposureId!);
        if(failure==='version')return scores(user,candidates,'v2');
        if(failure==='owner')response.userId='spotify:other';
        if(failure==='prediction')response.predictions[0]!.prediction.removalProbability=0.99;
        if(failure==='duplicate')response.predictions[1]=response.predictions[0]!;
        if(failure==='missing')response.predictions.pop();
        if(failure==='kind')response.predictions[0]!.prediction.modelKind='tree';
      }
      return response;
    }});
    const result=await service.get('spotify:owner',query);
    expect(result.items.map(i=>i.track.trackId)).toEqual([row(1).track.trackId,row(2).track.trackId]);
    expect(result.items.every(i=>i.prediction.modelKind==='untrained'&&!keyedIds.includes(i.exposure.exposureId))).toBe(true);
    expect(result.fallbackReason).toContain('unavailable');
  }
});

test('batch floating point roundoff is accepted; keyed snapshot is canonical',async()=>{
  const {service,stored}=setup([row(1)],{score:async(user,candidates,pinned)=>scores(user,candidates,pinned??'v1',()=>pinned?0.7+Number.EPSILON:0.7)});
  const result=await service.get('spotify:owner',query);
  expect(result.items[0]!.prediction.removalProbability).toBe(0.7+Number.EPSILON);
  expect(stored[0]!.prediction).toEqual(result.items[0]!.prediction);
});

test('both passes share one total scoring deadline',async()=>{
  let calls=0;
  const {service}=setup([row(1)],{scoreTimeoutMs:100,score:async(user,candidates,pinned)=>{
    calls++;await Bun.sleep(pinned?75:65);return scores(user,candidates,pinned??'v1');
  }});
  const result=await service.get('spotify:owner',query);
  expect(calls).toBe(2);expect(result.items[0]!.prediction.modelKind).toBe('untrained');
  expect(result.fallbackReason).toContain('unavailable');
});

test('empty and oversized pools avoid upstream calls; large pools remain usable',async()=>{
  for(const rows of [[],Array.from({length:10001},(_,i)=>row(i+1))]){
    let calls=0;
    const {service}=setup(rows,{score:async()=>{calls++;throw new Error('unexpected score');}});
    const result=await service.get('spotify:owner',query);
    expect(calls).toBe(0);expect(result.remaining).toBe(rows.length);
    expect(result.items).toHaveLength(Math.min(2,rows.length));
    if(rows.length)expect(result.fallbackReason).toContain('pool');
  }
});

test('awaits one async candidate load and preserves its features across pinned scoring', async () => {
  let loads=0,scores=0;
  const {service,stored}=setup(undefined,{
    load:async(rows,ctx)=>{loads++;await Bun.sleep(1);return {listeningContext:listeningSnapshot(ctx.now),candidates:assembleLibraryCandidates(rows,{userId:ctx.userId,now:new Date(ctx.now).toISOString()}).map(c=>({...c,features:{...c.features,values:{...c.features.values,recent_play_count:3}}}))};},
    assemble:()=>{throw Error('legacy assembly must not run');},
    score:async(userId,candidates)=>{scores++;expect(loads).toBe(1);expect(candidates.every(c=>c.features.values.recent_play_count===3)).toBe(true);candidates[0]!.features.values.recent_play_count=99;return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};},
  });
  await service.get('spotify:owner',{limit:2,policy:'balanced',mode:'spotify'});
  expect(loads).toBe(1);expect(scores).toBe(2);expect(stored.every(e=>e.features.values.recent_play_count===3)).toBe(true);expect(stored.map(e=>e.listeningContext)).toEqual(stored.map(()=>listeningSnapshot(now)));
});

test('loader failures and corrupt coverage cannot publish misleading exposures',async()=>{
 for(const invalid of [false,true]){
  const f=setup(undefined,{load:async(rows,ctx)=>{
   if(!invalid)throw Error('cache loader failed');
   return {candidates:assembleLibraryCandidates(rows,{userId:ctx.userId,now:new Date(ctx.now).toISOString()}),listeningContext:{...listeningSnapshot(now),completeHistory:true} as never};
  }});
  await expect(f.service.get('spotify:owner',{limit:1,policy:'balanced',mode:'spotify'})).rejects.toThrow();expect(f.stored).toHaveLength(0);
 }
});

test('coverage is detached from the loader before scoring and from each persisted exposure',async()=>{
 const coverage=listeningSnapshot(now),expected=structuredClone(coverage);
 const f=setup(undefined,{load:async(rows,ctx)=>({candidates:assembleLibraryCandidates(rows,{userId:ctx.userId,now:new Date(ctx.now).toISOString()}),listeningContext:coverage}),
  score:async(userId,candidates)=>{coverage.cachedEventCount=50;return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};},
 });
 const originalInsert=f.repository.insertExposure;
 f.repository.insertExposure=async input=>{await originalInsert(input);input.listeningContext!.cachedEventCount=49;};
 await f.service.get('spotify:owner',{limit:2,policy:'balanced',mode:'spotify'});
 expect(f.stored.map(e=>e.listeningContext)).toEqual([expected,expected]);
});
