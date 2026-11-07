import {expect, test} from 'bun:test';
import Fastify from 'fastify';
import {createDemoQueue} from '@sortfm/contracts/fixtures';
import {assembleLibraryCandidates} from '../ml';
import {FEATURE_VERSION, QueueResultSchema, type ExposureInput, type Prediction} from '@sortfm/contracts';
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
    expect(candidates.every(x=>Boolean(x.exposureId))).toBe(true);
    return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};
  }});
  const result=await service.get('spotify:owner',{limit:2,policy:'certainty',mode:'spotify'});
  expect(result.items[0]!.prediction).toEqual(prediction); expect(stored[0]!.prediction).toEqual(prediction);
  expect(result.items[0]!.exposure.selectionMethod).toBe('deterministic_baseline');
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
    scoredId=candidates[0]!.exposureId;
    candidates[0]!.features.values.duration_ms=42;
    await new Promise(resolve=>setTimeout(resolve,15));
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
