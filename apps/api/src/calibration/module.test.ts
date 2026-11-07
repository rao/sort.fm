import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {createCalibrationModule} from './module';
import {CalibrationQueue} from './queue';
import {CalibrationService} from './service';
import {fixture,now,owner,row} from './test-fixtures';
const origin='http://127.0.0.1:5173',headers={cookie:'sortfm_session=valid',origin};
async function appFixture(secure=false){
 const f=fixture();let kicks=0;const service=new CalibrationService(f.store,{now:()=>now,feedback:{kick(){kicks++;}}});
 const queue=new CalibrationQueue(f.store,{now:()=>now});const app=Fastify();
 await app.register(createCalibrationModule({service,queue,config:{secureCookies:secure,webOrigin:origin,apiOrigin:'http://127.0.0.1:3000'},auth:{session:async token=>token==='valid'?{user:{id:owner}}:null}}).registerRoutes);
 return {...f,service,queue,app,kicks:()=>kicks};
}
const label=(value:0|1=1)=>({trackId:row(1).track.trackId,exposureId:crypto.randomUUID(),label:value,idempotencyKey:crypto.randomUUID()});

test('HTTP labels for both classes, reload/history, same-key retry and label Undo have no Spotify transport or cleanup routes',async()=>{
 const f=await appFixture(),original=globalThis.fetch;let network=0;
 globalThis.fetch=Object.assign(async()=>{network++;throw Error('No provider transport allowed');},{preconnect:original.preconnect}) as typeof fetch;
 try{
  const queue=await f.app.inject({url:'/api/calibration/queue?limit=2',headers});expect(queue.statusCode).toBe(200);expect(queue.json().mode).toBe('calibration');
  expect(queue.headers['cache-control']).toBe('no-store');
  for(const value of [0,1] as const){
   const input=label(value),created=await f.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:input});
   expect(created.statusCode).toBe(200);expect(created.json()).toMatchObject({mode:'calibration',submittedLabel:value,label:value,state:'active'});
   const retry=await f.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:input});expect(retry.json()).toEqual(created.json());
   const history=await f.app.inject({url:'/api/calibration/history',headers});expect(history.json().items.some((r:any)=>r.idempotencyKey===input.idempotencyKey)).toBe(true);
   const undo=await f.app.inject({method:'POST',url:`/api/calibration/labels/${created.json().labelId}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID()}});
   expect(undo.statusCode).toBe(200);expect(undo.json()).toMatchObject({state:'revoked',label:null,canUndo:false});
  }
  expect((await f.app.inject({method:'POST',url:'/api/decisions',headers,payload:{}})).statusCode).toBe(404);
  expect(network).toBe(0);expect(f.kicks()).toBe(6);expect(f.rows.every(r=>r.currentStatus==='saved'&&r.currentDecision===null)).toBe(true);
 }finally{globalThis.fetch=original;await f.app.close();}
});

test('anonymous, duplicate, malformed and wrong production cookies cannot access calibration',async()=>{
 for(const secure of [false,true]){
  const f=await appFixture(secure),cookie=secure?'__Host-sortfm_session':'sortfm_session';
  try{
   for(const cookieHeader of ['',`${cookie}=bad`,`${cookie}=valid; ${cookie}=valid`,`${cookie}=%ZZ`,...(secure?['sortfm_session=valid']:[])]){
    const response=await f.app.inject({url:'/api/calibration/queue',headers:{cookie:cookieHeader}});expect(response.statusCode).toBe(401);
   }
   expect(f.calls).toHaveLength(0);
   expect((await f.app.inject({url:'/api/calibration/history',headers:{cookie:`${cookie}=valid`}})).statusCode).toBe(200);
   expect(f.calls[0]).toEqual({method:'history',value:owner});
  }finally{await f.app.close();}
 }
});

test('strict schemas and CSRF reject authority injection, Skip, cleanup actions and cross-site writes before store calls',async()=>{
 const f=await appFixture();
 try{
  for(const payload of [{...label(),userId:'foreign'},{...label(),purpose:'review'},{...label(),split:'train'},{...label(),action:'UNLIKE'},{...label(),label:'SKIP'},{...label(),label:null}]){
   expect((await f.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload})).statusCode).toBe(400);
  }
  for(const badHeaders of [{cookie:headers.cookie},{...headers,origin:'https://evil.test'},{...headers,'sec-fetch-site':'cross-site'}]){
   expect((await f.app.inject({method:'POST',url:'/api/calibration/labels',headers:badHeaders,payload:label()})).statusCode).toBe(403);
  }
  for(const url of ['/api/calibration/queue?userId=foreign','/api/calibration/queue?policy=balanced','/api/calibration/history?limit=1']){
   expect((await f.app.inject({url,headers})).statusCode).toBe(400);
  }
  expect((await f.app.inject({method:'POST',url:'/api/calibration/labels/no-uuid/undo',headers,payload:{idempotencyKey:crypto.randomUUID()}})).statusCode).toBe(400);
  expect((await f.app.inject({method:'POST',url:`/api/calibration/labels/${crypto.randomUUID()}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID(),trackId:row(1).track.trackId}})).statusCode).toBe(400);
  expect(f.calls).toHaveLength(0);
 }finally{await f.app.close();}
});

test('maps real persistence conflicts and missing identities safely; unknown failures never leak private text',async()=>{
 const f=await appFixture();
 try{
  for(const [code,status] of [['EXPOSURE_PURPOSE_MISMATCH',409],['CALIBRATION_LABEL_ACTIVE',409],['CALIBRATION_NOT_ELIGIBLE',409],['STALE_CALIBRATION_LABEL',409],['MUTATION_PENDING',409],['IDEMPOTENCY_CONFLICT',409],['EXPOSURE_NOT_FOUND',404],['CALIBRATION_LABEL_NOT_FOUND',404],['TRACK_NOT_OWNED',404],['UNKNOWN_INTERNAL',503]] as const){
   f.store.createCalibrationLabel=async()=>{throw Object.assign(Error('secret bearer token'),{code});};
   const response=await f.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:label()});
   expect(response.statusCode).toBe(status);expect(response.body).not.toContain('secret');expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(f.kicks()).toBe(0);
 }finally{await f.app.close();}
});

test('malformed downstream data is an upstream failure, not a caller validation error',async()=>{
 const f=await appFixture();
 try{
  f.store.calibrationHistory=async()=>({items:[{}],nextCursor:null}) as never;
  const response=await f.app.inject({url:'/api/calibration/history',headers});expect(response.statusCode).toBe(502);
  f.store.calibrationCandidates=async()=>({library:[{...row(1),track:{...row(1).track,durationMs:-1}}],eligibleTrackIds:[row(1).track.trackId]});
  const queue=await f.app.inject({url:'/api/calibration/queue',headers});expect(queue.statusCode).toBe(502);
 }finally{await f.app.close();}
});

test('cleanup surface reports D wrong-purpose rejection as a conflict without exposing internals',async()=>{
 const {reviewRouteSecurity}=await import('../reviews/module');
 const app=Fastify(),security=reviewRouteSecurity({config:{secureCookies:false,webOrigin:origin,apiOrigin:'http://localhost:3001'},auth:{session:async()=>({user:{id:owner}})}});
 app.post('/purpose-conflict',security.safe(async()=>{throw Object.assign(Error('private database detail'),{code:'EXPOSURE_PURPOSE_MISMATCH'});}));
 try{
  const response=await app.inject({method:'POST',url:'/purpose-conflict',headers});
  expect(response.statusCode).toBe(409);expect(response.json().code).toBe('EXPOSURE_PURPOSE_MISMATCH');expect(response.body).not.toContain('private database detail');
 }finally{await app.close();}
});
