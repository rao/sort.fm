import {afterEach,expect,test} from 'bun:test';
import type {FastifyInstance} from 'fastify';
import {PUBLIC_ROUTES,FEATURE_VERSION,ExposureInputSchema,type ReviewResult} from '@sortfm/contracts';
import {createDemoQueue,untrainedPrediction} from '@sortfm/contracts/fixtures';
import {buildApp} from '../app';
import {loadConfig} from '../config';
import {installPilotGuards,type PilotAdmissionPort} from './pilot';
const apps:FastifyInstance[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const config={...loadConfig({NODE_ENV:'test'}),secureCookies:false};
const owner='spotify:owner',trackId='0000000000000000000001';
const request={trackId,action:'KEEP' as const,exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()};
const exposure=ExposureInputSchema.parse({userId:owner,exposure:{...createDemoQueue().items[0]!.exposure,exposureId:request.exposureId,trackId},prediction:untrainedPrediction,features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:false}});
const decision={...request,decisionId:crypto.randomUUID(),mode:'spotify',status:'PENDING'} as ReviewResult;
const headers={cookie:'sortfm_session=valid',origin:config.webOrigin};
async function setup(overrides:Partial<PilotAdmissionPort>={},allowSpotifyMutations?:boolean) {
 let calls=0,reads=0;
 const admission:PilotAdmissionPort={getPublishedExposure:async(user,id)=>{reads++;expect(user).toBe(owner);expect(id).toBe(request.exposureId);return exposure;},getDecision:async()=>decision,getDecisionByIdempotencyKey:async()=>null,getUndoByIdempotencyKey:async()=>null,...overrides};
 const app=await buildApp({config,beforeRoutes:app=>installPilotGuards(app,{config,auth:{session:async(token)=>token==='valid'?{user:{id:owner}}:null},admission,allowSpotifyMutations}),registerRoutes:app=>{
  for(const [name,route] of Object.entries(PUBLIC_ROUTES))if(!['health','demoBootstrap'].includes(name))app.route({method:route.method,url:route.path,handler:async()=>{calls++;return {ok:true};}});
  app.post('/api/future',async()=>{calls++;return {ok:true};});
 }});apps.push(app);return {app,calls:()=>calls,reads:()=>reads};
}
test('pre-route installer runs before every route and startup; rejection prevents module startup',async()=>{
 const events:string[]=[];
 const app=await buildApp({beforeRoutes:async app=>{events.push('guard');app.addHook('onRequest',async(_req,reply)=>{reply.code(403).send({blocked:true});});},registerRoutes:app=>{events.push('register');app.addHook('onReady',async()=>{events.push('ready');});}});apps.push(app);
 expect(events).toEqual(['guard','register','ready']);
 for(const url of ['/api/health','/api/demo/bootstrap','/api/me','/missing'])expect((await app.inject(url)).statusCode).toBe(403);
 await expect(buildApp({beforeRoutes:()=>{throw Error('installer failed');},registerRoutes:()=>{events.push('unexpected');}})).rejects.toThrow('installer failed');
 expect(events).not.toContain('unexpected');
});
test('default deny covers all unapproved routes, unknown routes, HEAD and future registrations',async()=>{
 const s=await setup();
 const permitted=new Set(['health','authStart','authCallback','logout','me','librarySummary','queue','decide','undo','history','analytics','insights','calibrationCorrection','calibrationHistory','calibrationUndo']);
 for(const [name,route] of Object.entries(PUBLIC_ROUTES))if(!permitted.has(name)){
  const res=await s.app.inject({method:route.method,url:route.path.replace(':id',decision.decisionId).replace(':experiment','batch3'),headers,payload:route.method==='POST'?{}:undefined});
  expect(res.statusCode).toBe(403);expect(res.json().code).toBe('PILOT_ACTION_NOT_ALLOWED');
 }
 for(const [method,url] of [['POST','/api/future'],['GET','/missing'],['HEAD','/api/health'],['POST','/api/health']] as const)expect((await s.app.inject({method,url,headers})).statusCode).toBe(403);
 expect(s.calls()).toBe(0);expect(s.reads()).toBe(0);
});
test('health and primary OAuth are public; reads require session and queue refuses demo',async()=>{
 const s=await setup();
 for(const url of ['/api/health','/api/auth/spotify/start','/api/auth/spotify/callback?code=x&state=x'])expect((await s.app.inject(url)).statusCode).toBe(200);
 for(const url of ['/api/me','/api/queue','/api/decisions/history','/api/library/summary','/api/ml/insights','/api/analytics/summary']){
  expect((await s.app.inject(url)).statusCode).toBe(401);expect((await s.app.inject({url,headers})).statusCode).toBe(200);
 }
 expect((await s.app.inject({url:'/api/queue?mode=demo',headers})).statusCode).toBe(403);
 expect((await s.app.inject({url:'/api/queue?limit=0',headers})).statusCode).toBe(400);
 for(const state of ['playback-sdk.x','playback-control.x','playback-malformed'])expect((await s.app.inject(`/api/auth/spotify/callback?state=${state}`)).statusCode).toBe(403);
});
test('KEEP/SKIP admission requires session, CSRF and exact published owner/exposure/track',async()=>{
 const s=await setup();
 for(const action of ['KEEP','SKIP'])expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,action}})).statusCode).toBe(200);
 for(const action of ['ARCHIVE','UNLIKE'])expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,action}})).statusCode).toBe(403);
 for(const cookie of ['','sortfm_session=expired','sortfm_session=valid; sortfm_session=valid','sortfm_session=%ZZ'])expect((await s.app.inject({method:'POST',url:'/api/decisions',headers:{...headers,cookie},payload:request})).statusCode).toBe(401);
 for(const h of [{cookie:headers.cookie},{...headers,'sec-fetch-site':'cross-site'},{...headers,origin:'https://evil.test'}])expect((await s.app.inject({method:'POST',url:'/api/decisions',headers:h,payload:request})).statusCode).toBe(403);
 expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,userId:owner}})).statusCode).toBe(400);
 expect(s.calls()).toBe(2);
 for(const row of [null,{...exposure,userId:'foreign'},{...exposure,exposure:{...exposure.exposure,trackId:'wrong'}},{...exposure,exposure:{...exposure.exposure,exposureId:crypto.randomUUID()}}]){
  const t=await setup({getPublishedExposure:async()=>row});
  expect((await t.app.inject({method:'POST',url:'/api/decisions',headers,payload:request})).statusCode).toBe(403);expect(t.calls()).toBe(0);
 }
});
test('existing decision replay still requires pilot publication and identical command',async()=>{
 for(const existing of [decision,{...decision,trackId:'wrong'},{...decision,action:'UNLIKE' as const}]){
  const s=await setup({getDecisionByIdempotencyKey:async()=>existing,getPublishedExposure:async()=>null});
  expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:request})).statusCode).toBe(existing===decision?403:409);expect(s.calls()).toBe(0);
 }
 const s=await setup({getDecisionByIdempotencyKey:async()=>decision});
 expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:request})).statusCode).toBe(200);
});
test('Undo and already-undone replay reject inherited and destructive decisions before handler',async()=>{
 const payload={idempotencyKey:crypto.randomUUID()},url=`/api/decisions/${decision.decisionId}/undo`;
 for(const status of ['COMPLETE','UNDONE'] as const){
  const s=await setup({getDecision:async()=>({...decision,status}),getPublishedExposure:async()=>null});
  expect((await s.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403);expect(s.calls()).toBe(0);
 }
 for(const row of [null,{...decision,action:'UNLIKE' as const},{...decision,decisionId:crypto.randomUUID()}]){
  const s=await setup({getDecision:async()=>row});expect((await s.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403);expect(s.calls()).toBe(0);
 }
 const s=await setup();expect((await s.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(200);
 expect((await s.app.inject({method:'POST',url:'/api/decisions/bad/undo',headers,payload})).statusCode).toBe(400);
});
test('expected persistence denials are terminal; unavailable admission fails closed without details',async()=>{
 for(const code of ['REVIEW_EXPOSURE_NOT_PUBLISHED','REVIEW_TRACK_EXCLUDED','REVIEW_OWNER_MISMATCH','REVIEW_ACTION_NOT_ALLOWED','DATABASE_OFFLINE']){
  const s=await setup({getPublishedExposure:async()=>{throw Object.assign(Error('private detail'),{code});}});
  const res=await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:request});
  expect(res.statusCode).toBe(code==='DATABASE_OFFLINE'?503:403);expect(res.body).not.toContain('private');expect(res.json().retryable).toBe(code==='DATABASE_OFFLINE');expect(s.calls()).toBe(0);
 }
});

test('approved mutation pilot admits all four actions and their Undo without widening routes or publication fences',async()=>{
 const s=await setup({},true);
 for(const action of ['KEEP','ARCHIVE','SKIP','UNLIKE'])expect((await s.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,action}})).statusCode).toBe(200);
 for(const action of ['ARCHIVE','UNLIKE'] as const){
  const t=await setup({getDecision:async()=>({...decision,action,status:'COMPLETE'})},true);
  expect((await t.app.inject({method:'POST',url:`/api/decisions/${decision.decisionId}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID()}})).statusCode).toBe(200);
  const excluded=await setup({getPublishedExposure:async()=>null,getDecision:async()=>({...decision,action})},true);
  for(const [url,payload] of [['/api/decisions',{...request,action}],[`/api/decisions/${decision.decisionId}/undo`,{idempotencyKey:crypto.randomUUID()}]] as const)expect((await excluded.app.inject({method:'POST',url,headers,payload})).statusCode).toBe(403);
  expect(excluded.calls()).toBe(0);
  expect((await t.app.inject({method:'POST',url:'/api/decisions',headers:{...headers,origin:'https://foreign.test'},payload:{...request,action}})).statusCode).toBe(403);
 }
 for(const url of ['/api/library/sync','/api/player/connect','/api/player/play','/api/ml/retrain','/api/calibration/labels'])expect((await s.app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(403);
 expect(s.calls()).toBe(4);
 const disabled=await setup({},false);expect((await disabled.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,action:'UNLIKE'}})).statusCode).toBe(403);
});


test('pilot preference confirmation is available without mutation opt-in, bound to a published Skip; ordinary calibration stays denied',async()=>{
 const skip={...decision,action:'SKIP' as const,status:'COMPLETE' as const},payload={decisionId:decision.decisionId,label:1,idempotencyKey:crypto.randomUUID()};
 const s=await setup({getDecision:async()=>skip});
 expect((await s.app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload})).statusCode).toBe(200);
 expect((await s.app.inject({url:'/api/calibration/history',headers})).statusCode).toBe(200);
 expect((await s.app.inject({method:'POST',url:`/api/calibration/labels/${crypto.randomUUID()}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID()}})).statusCode).toBe(200);
 for(const body of [{...payload,label:0},{...payload,userId:owner},{...payload,split:'train'}])expect((await s.app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload:body})).statusCode).toBe(400);
 for(const path of ['/api/calibration/queue','/api/calibration/batch2'])expect((await s.app.inject({url:path,headers})).statusCode).toBe(403);
 expect((await s.app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:{}})).statusCode).toBe(403);
 for(const getDecision of [async()=>null,async()=>decision,async()=>({...skip,mode:'demo' as const})]){const denied=await setup({getDecision});expect((await denied.app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload})).statusCode).toBe(403);expect(denied.calls()).toBe(0);}
 const inherited=await setup({getDecision:async()=>skip,getPublishedExposure:async()=>null});expect((await inherited.app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload})).statusCode).toBe(403);expect(inherited.calls()).toBe(0);
});
