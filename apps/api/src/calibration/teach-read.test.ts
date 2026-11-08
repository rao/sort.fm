import {afterEach,expect,test} from 'bun:test';
import Fastify from 'fastify';
import {PUBLIC_ROUTES,IdempotencyKeySchema,type CalibrationLabelResult,type TeachingStatus} from '@sortfm/contracts';
import {CalibrationService} from './service';
import {createCalibrationModule,type CalibrationModuleOptions} from './module';
import {fixture,owner} from './test-fixtures';
const other='spotify:other',at='2026-11-08T12:00:00.000Z';
const status:TeachingStatus={trainingFeedbackCount:3,feedbackRevision:8,synchronizedFeedbackRevision:6,modelVersion:'fixture-v1'};
const label:CalibrationLabelResult={mode:'calibration',labelId:'00000000-0000-4000-8000-000000000001',trackId:'0000000000000000000001',exposureId:'00000000-0000-4000-8000-000000000002',idempotencyKey:IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000003'),submittedLabel:0,label:0,state:'active',canUndo:true,feedbackRevision:8,createdAt:at,updatedAt:at};
const history={items:[label],nextCursor:null};
const paths=[PUBLIC_ROUTES.teachHistory.path,PUBLIC_ROUTES.teachingStatus.path];
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(options:{secure?:boolean;missingStore?:boolean;legacyService?:boolean;auth?:CalibrationModuleOptions['auth'];timeoutMs?:number}={}){
 const f=fixture(),reads:{method:string;userId:string}[]=[];let kicks=0;
 if(!options.missingStore){
  f.store.teachHistory=async userId=>{reads.push({method:'teach',userId});return userId===owner?history:{items:[],nextCursor:null};};
  f.store.teachingStatus=async userId=>{reads.push({method:'status',userId});return userId===owner?status:{trainingFeedbackCount:0,feedbackRevision:0,synchronizedFeedbackRevision:null,modelVersion:null};};
 }
 const service=new CalibrationService(f.store,{feedback:{kick(){kicks++;}}});
 const app=Fastify();apps.push(app);
 await app.register(createCalibrationModule({service:options.legacyService?{label:service.label.bind(service),undo:service.undo.bind(service),history:service.history.bind(service)}:service,
  queue:{get:async()=>{throw Error('Queue must not run');}},readTimeoutMs:options.timeoutMs??1000,
  config:{secureCookies:options.secure??false,webOrigin:'http://localhost:5173',apiOrigin:'http://localhost:3000'},
  auth:options.auth??{session:async token=>token==='owner'?{user:{id:owner}}:token==='other'?{user:{id:other}}:null},
 }).registerRoutes);
 return {...f,service,app,reads,kicks:()=>kicks};
}
const headers={cookie:'sortfm_session=owner'};
function safe(response:{body:string;headers:Record<string,unknown>}){
 expect(response.headers['cache-control']).toBe('no-store');expect(response.body).not.toContain('private');expect(response.body).not.toContain(owner);
}
test('Teach reads validate dedicated store snapshots, retain acknowledged model revision, and never kick or write',async()=>{
 const f=await setup();
 const h=await f.app.inject({url:paths[0],headers}),s=await f.app.inject({url:paths[1],headers});
 expect(h.statusCode).toBe(200);expect(h.json()).toEqual(history);safe(h);
 expect(s.statusCode).toBe(200);expect(s.json()).toEqual(status);safe(s);
 expect(PUBLIC_ROUTES.teachHistory.response.safeParse(h.json()).success).toBe(true);
 expect(PUBLIC_ROUTES.teachingStatus.response.safeParse(s.json()).success).toBe(true);
 expect(f.reads).toEqual([{method:'teach',userId:owner},{method:'status',userId:owner}]);expect(f.calls).toEqual([]);expect(f.exposures).toEqual([]);expect(f.kicks()).toBe(0);
 await f.app.inject({url:paths[0],headers});expect(f.reads).toHaveLength(3);
});
test('Teach service rejects unsupported and malformed reads, including invalid model acknowledgement',async()=>{
 const f=await setup({missingStore:true});
 await expect(f.service.teachHistory(owner)).rejects.toMatchObject({statusCode:503});
 await expect(f.service.teachingStatus(owner)).rejects.toMatchObject({statusCode:503});
 f.store.teachHistory=async()=>({items:[{...label,state:'revoked'}],nextCursor:null}) as never;
 await expect(f.service.teachHistory(owner)).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});
 for(const bad of [{...status,synchronizedFeedbackRevision:9},{...status,modelVersion:null},{...status,trainingFeedbackCount:-1},{...status,private:'secret'}]){
  f.store.teachingStatus=async()=>bad as never;
  await expect(f.service.teachingStatus(owner)).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});
 }
 await expect(f.service.teachHistory('invalid/owner')).rejects.toThrow();expect(f.kicks()).toBe(0);
});
test('Teach routes derive each owner from the session and reject all selectors and bodies before reading',async()=>{
 const f=await setup();
 for(const path of paths){
  const foreign=await f.app.inject({url:path,headers:{cookie:'sortfm_session=other'}});expect(foreign.statusCode).toBe(200);expect(foreign.body).not.toContain(label.trackId);expect(foreign.body).not.toContain('fixture-v1');
  for(const suffix of ['?userId=spotify:other','?limit=1','?cursor=x'])expect((await f.app.inject({url:path+suffix,headers})).statusCode).toBe(400);
  for(const bodyHeaders of [{'content-type':'application/json'},{'transfer-encoding':'chunked','content-type':'application/json'}]){
   const response=await f.app.inject({method:'GET',url:path,headers:{...headers,...bodyHeaders},payload:'{}'});expect(response.statusCode).toBe(400);safe(response);
  }
  for(const framing of [{'content-length':'1'},{'transfer-encoding':'chunked'}]){
   const response=await f.app.inject({url:path,headers:{...headers,...framing}});expect(response.statusCode).toBe(400);safe(response);
  }
  const origin=await f.app.inject({url:path,headers:{...headers,origin:'https://foreign.example'}});expect(origin.statusCode).toBe(403);safe(origin);
 }
 expect(f.reads).toEqual([{method:'teach',userId:other},{method:'status',userId:other}]);expect(f.calls).toEqual([]);
});
test('Teach rejects anonymous, ambiguous and malformed cookies with secure-cookie behavior',async()=>{
 for(const secure of [false,true]){
  const f=await setup({secure}),cookie=secure?'__Host-sortfm_session':'sortfm_session';
  for(const path of paths){
   for(const value of ['',`${cookie}=invalid`,`${cookie}=owner; ${cookie}=owner`,`${cookie}=%ZZ`,...(secure?['sortfm_session=owner']:[])]){
    const response=await f.app.inject({url:path,headers:{cookie:value}});expect(response.statusCode).toBe(401);safe(response);
   }
   expect((await f.app.inject({url:path,headers:{cookie:`${cookie}=owner`}})).statusCode).toBe(200);
  }
  expect(f.reads).toHaveLength(2);
 }
});
test('legacy services and absent optional stores fail explicitly without disrupting ordinary history',async()=>{
 for(const options of [{legacyService:true},{missingStore:true}]){
  const f=await setup(options);
  for(const path of paths){const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(503);safe(r);}
  expect((await f.app.inject({url:PUBLIC_ROUTES.calibrationHistory.path,headers})).statusCode).toBe(200);
 }
});
test('Teach read failures are sanitized and both authentication and persistence have deadlines',async()=>{
 for(const method of ['teachHistory','teachingStatus'] as const){
  const path=PUBLIC_ROUTES[method].path;
  for(const kind of ['error','malformed','slow'] as const){
   const f=await setup({timeoutMs:5});
   f.store[method]=(async()=>{if(kind==='error')throw Error('private database credential');if(kind==='slow')return new Promise(()=>{});return {private:'secret'};}) as never;
   const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(kind==='malformed'?502:503);safe(r);expect(f.kicks()).toBe(0);
  }
  const f=await setup({timeoutMs:5,auth:{session:()=>new Promise(()=>{})}});
  const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(503);safe(r);expect(f.reads).toEqual([]);
 }
});

test('Teach HTTP boundary also validates optional service implementations before serialization',async()=>{
 const f=await setup();
 f.service.teachHistory=async()=>({items:[],nextCursor:null,private:'secret'}) as never;
 f.service.teachingStatus=async()=>({...status,synchronizedFeedbackRevision:99});
 for(const path of paths){const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(502);safe(r);}
 expect(f.reads).toEqual([]);
});
