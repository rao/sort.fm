import {afterEach,expect,test} from 'bun:test';
import Fastify from 'fastify';
import {PUBLIC_ROUTES,TasteConstellationSchema,type ConstellationProjection} from '@sortfm/contracts';
import {createTasteConstellationModule} from './constellation';
const owner='spotify:owner',other='spotify:other',at='2026-11-08T12:00:00.000Z';
const id=(n:number)=>String(n).padStart(22,'0');
const row=(n=1)=>({id:id(n),title:'Synthetic fixture',artist:'Fixture artist',imageUrl:null,label:null,audio:{energy:0,happiness:null}});
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(options:{read?:()=>Promise<unknown>;authenticated?:boolean;timeoutMs?:number;auth?:()=>Promise<{user:{id:string}}|null>;missing?:boolean}={}){
 const calls:string[]=[],snapshot:ConstellationProjection={userId:owner,tracks:[row()]};
 const app=Fastify();apps.push(app);
 const module=createTasteConstellationModule({config:{secureCookies:false,webOrigin:'http://127.0.0.1:5173',apiOrigin:'http://127.0.0.1:3000'},
  auth:{session:options.auth??(async()=>options.authenticated===false?null:{user:{id:owner}})},
  projection:options.missing?null:{constellation:async user=>{calls.push(user);return (options.read?await options.read():snapshot) as ConstellationProjection;}},
  now:()=>Date.parse(at),readTimeoutMs:options.timeoutMs??1000,
 });
 await app.register(module.registerRoutes);return {app,calls,snapshot};
}
function safe(response:{statusCode:number;headers:Record<string,unknown>;body:string}){
 expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['referrer-policy']).toBe('no-referrer');
 expect(response.body).not.toContain(owner);expect(response.body).not.toContain('private');
}
test('authenticated projection preserves observed zero and missing values without inventing scores or labels',async()=>{
 const f=await setup();f.snapshot.tracks=[row(),{...row(2),label:'keep',audio:{}},{...row(3),label:'remove',audio:{tempo_bpm:110,loudness_db:-12}}];
 const before=structuredClone(f.snapshot),response=await f.app.inject(PUBLIC_ROUTES.constellation.path);safe(response);
 expect(response.statusCode).toBe(200);expect(response.json()).toEqual({schema:'sortfm.constellation.v1',mode:'live',privacy:'evaluation-excluded',generatedAt:at,modelVersion:null,tracks:before.tracks.map(track=>({...track,prediction:null}))});
 expect(TasteConstellationSchema.safeParse(response.json()).success).toBe(true);expect(f.calls).toEqual([owner]);expect(f.snapshot).toEqual(before);
});
test('anonymous or foreign-origin reads never enter projection',async()=>{
 const a=await setup({authenticated:false});const anonymous=await a.app.inject(PUBLIC_ROUTES.constellation.path);safe(anonymous);expect(anonymous.statusCode).toBe(401);expect(a.calls).toEqual([]);
 const b=await setup();const foreign=await b.app.inject({url:PUBLIC_ROUTES.constellation.path,headers:{origin:'https://foreign.example'}});safe(foreign);expect(foreign.statusCode).toBe(403);expect(b.calls).toEqual([]);
});
test('no owner, model, pagination or body selector is accepted',async()=>{
 for(const suffix of ['?userId=spotify:other','?limit=20','?modelVersion=latest','?mode=synthetic']){
  const f=await setup();const r=await f.app.inject(PUBLIC_ROUTES.constellation.path+suffix);safe(r);expect(r.statusCode).toBe(400);expect(f.calls).toEqual([]);
 }
 const f=await setup();const r=await f.app.inject({method:'GET',url:PUBLIC_ROUTES.constellation.path,headers:{'content-type':'application/json'},payload:'{}'});safe(r);expect(r.statusCode).toBe(400);expect(f.calls).toEqual([]);
});
test('cross-owner, malformed, oversized, duplicate or synthetic projections fail closed as a whole',async()=>{
 const bad:unknown[]=[{userId:other,tracks:[row()]},{userId:owner,tracks:[row(),row()]},{userId:owner,tracks:[{...row(),id:'demo:constellation:1'}]},
  {userId:owner,tracks:[{...row(),audio:{energy:NaN}}]},{userId:owner,tracks:[{...row(),audio:{energy:2}}]},
  {userId:owner,tracks:[{...row(),audio:{imputed:0.5}}]},{userId:owner,tracks:[{...row(),label:'skip'}]},
  {userId:owner,tracks:[{...row(),prediction:{removalProbability:1}}]},{userId:owner,tracks:[row()],excludedIds:['private']},
  {userId:owner,tracks:[{...row(),imageUrl:'http://example.test/image'}]},{userId:owner,tracks:Array.from({length:5001},(_,n)=>row(n+1))}];
 for(const value of bad){const f=await setup({read:async()=>value});const r=await f.app.inject(PUBLIC_ROUTES.constellation.path);safe(r);expect(r.statusCode).toBe(503);expect(r.json()).toEqual({code:'CONSTELLATION_UNAVAILABLE',message:'Taste Constellation is temporarily unavailable. Retry later.',retryable:true});expect(r.body).not.toContain('Synthetic fixture');}
});
test('missing privacy dependencies, repository failures and slow reads return only a bounded safe error',async()=>{
 for(const options of [{missing:true},{read:async()=>{throw Error('private exclusion identity');}},{read:()=>new Promise(()=>{}),timeoutMs:5},{auth:()=>new Promise<null>(()=>{}),timeoutMs:5}]){
  const f=await setup(options);const r=await f.app.inject(PUBLIC_ROUTES.constellation.path);safe(r);expect(r.statusCode).toBe(503);expect(r.json().code).toBe('CONSTELLATION_UNAVAILABLE');
 }
});
test('empty and maximum filtered libraries are valid; each refresh rereads without caching',async()=>{
 const f=await setup();f.snapshot.tracks=[];expect((await f.app.inject(PUBLIC_ROUTES.constellation.path)).json().tracks).toEqual([]);
 f.snapshot.tracks=Array.from({length:5000},(_,n)=>row(n+1));const result=await f.app.inject(PUBLIC_ROUTES.constellation.path);expect(result.statusCode).toBe(200);expect(result.json().tracks).toHaveLength(5000);expect(f.calls).toEqual([owner,owner]);
});
test('HTTP contract rejects synthetic mode while reusable graph schema retains it',()=>{
 const synthetic={schema:'sortfm.constellation.v1',mode:'synthetic',privacy:'evaluation-excluded',generatedAt:at,modelVersion:null,tracks:[{...row(),id:'demo:constellation:1',prediction:null}]};
 expect(TasteConstellationSchema.safeParse(synthetic).success).toBe(true);
 expect(PUBLIC_ROUTES.constellation.response.safeParse(synthetic).success).toBe(false);
});
