import {createIdempotencyKey} from '@sortfm/contracts/client';
import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {PersistenceError} from '@sortfm/db';
import {CALIBRATION_BATCH3_EXPERIMENT as id} from '@sortfm/contracts';
import {createCalibrationModule} from './module';
import {CalibrationExperimentService} from './experiment-service';
import {CalibrationService} from './service';
import {CalibrationQueue} from './queue';
import {experimentFixture,operatorInput,ready} from './experiment-test-fixtures';
import {fixture,owner,now} from './test-fixtures';
const origin='http://127.0.0.1:5173',headers={origin,cookie:'sortfm_session=valid'},path=`/api/calibration/experiments/${id}`;
async function setup(installed=true){const f=experimentFixture(),ordinary=fixture(),experiment=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score});
 await experiment.reserve(owner,operatorInput());f.calls.length=0;
 const app=Fastify();await app.register(createCalibrationModule({config:{secureCookies:false,webOrigin:origin,apiOrigin:'http://127.0.0.1:3000'},auth:{session:async t=>t==='valid'?{user:{id:owner}}:null},service:new CalibrationService(ordinary.store),queue:new CalibrationQueue(ordinary.store),...(installed?{experiment}: {})}).registerRoutes);
 return {...f,ordinary,app};}
test('reserved HTTP read is counts only, owner scoped and no-store; no reserve or seal route exists',async()=>{
 const f=await setup();try{
  const response=await f.app.inject({url:path,headers});expect(response.statusCode).toBe(200);expect(response.json().batch.phase).toBe('reserved');expect(response.headers['cache-control']).toBe('no-store');
  for(const key of ['queue','entries','predictions','candidates','research','seedPrecommit'])expect(response.json().batch[key]).toBeUndefined();
  for(const url of [path,`${path}/reserve`,`${path}/seal`,`${path}/snapshot`])expect((await f.app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(404);
  expect((await f.app.inject({url:`${path}/snapshot`,headers})).statusCode).toBe(404);expect(f.calls).toEqual(['read']);
 }finally{await f.app.close();}
});
test('experiment read/skip reject unknown IDs, authority injection, unauthenticated and cross-site calls',async()=>{
 const f=await setup(),payload={exposureId:crypto.randomUUID(),idempotencyKey:createIdempotencyKey()};try{
  expect((await f.app.inject({url:path})).statusCode).toBe(401);
  expect((await f.app.inject({url:path,headers:{cookie:'sortfm_session=valid; sortfm_session=valid'}})).statusCode).toBe(401);
  expect((await f.app.inject({url:'/api/calibration/experiments/other',headers})).statusCode).toBe(400);
  expect((await f.app.inject({url:`${path}?userId=other`,headers})).statusCode).toBe(400);
  for(const h of [{cookie:headers.cookie},{...headers,origin:'https://foreign.test'},{...headers,'sec-fetch-site':'cross-site'}])expect((await f.app.inject({method:'POST',url:`${path}/skip`,headers:h,payload})).statusCode).toBe(403);
  expect((await f.app.inject({method:'POST',url:`${path}/skip`,headers,payload:{...payload,experiment:'other',userId:'other'}})).statusCode).toBe(400);expect(f.calls).toEqual([]);
 }finally{await f.app.close();}
});
test('reserved admission rejection remains terminal and ready Skip uses the existing command shape',async()=>{
 const f=await setup(),payload={exposureId:crypto.randomUUID(),idempotencyKey:createIdempotencyKey()};try{
  f.store.skipCalibrationExperiment=async()=>{throw new PersistenceError('BATCH_NOT_READY');};
  const rejected=await f.app.inject({method:'POST',url:`${path}/skip`,headers,payload});expect(rejected.statusCode).toBe(409);expect(rejected.json()).toMatchObject({code:'BATCH_NOT_READY',retryable:false});
  f.store.skipCalibrationExperiment=async(user,experiment,input)=>{expect(user).toBe(owner);expect(experiment).toBe(id);expect(input).toEqual(payload);return ready(f.saved()!.draft);};
  expect((await f.app.inject({method:'POST',url:`${path}/skip`,headers,payload})).json().phase).toBe('ready');
  for(const method of ['createCalibrationLabel','undoCalibrationLabel'] as const)f.ordinary.store[method]=async()=>{throw new PersistenceError('BATCH_NOT_READY');};
  const label={trackId:f.rows[0]!.track.trackId,...payload,label:1};
  expect((await f.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:label})).statusCode).toBe(409);
  expect((await f.app.inject({method:'POST',url:`/api/calibration/labels/${crypto.randomUUID()}/undo`,headers,payload:{idempotencyKey:payload.idempotencyKey}})).statusCode).toBe(409);
 }finally{await f.app.close();}
});
test('unavailable experiment is explicit; corrupt reserved projection never leaks cards; Batch2 stays optional',async()=>{
 const f=await setup(false);try{const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(503);expect(r.json().code).toBe('BATCH_EXPERIMENT_UNAVAILABLE');expect((await f.app.inject({url:'/api/calibration/batch2',headers})).json().code).toBe('BATCH_UNAVAILABLE');}finally{await f.app.close();}
 const g=await setup();try{g.store.calibrationExperiment=async()=>({...await new CalibrationExperimentService(g.store).snapshot(owner,id),phase:'reserved',secret:'not public'}) as never;const r=await g.app.inject({url:path,headers});expect(r.statusCode).toBe(502);expect(r.body).not.toContain('not public');}finally{await g.app.close();}
});
