import {afterEach,expect,test} from 'bun:test';
import Fastify from 'fastify';
import {PUBLIC_ROUTES,type ConstellationHistoryProjection,type ConstellationReadPort} from '@sortfm/contracts';
import {createTasteConstellationModule} from './constellation';
const owner='spotify:owner',other='spotify:other',at='2026-11-08T12:00:00.000Z',path=PUBLIC_ROUTES.constellationHistory.path;
const row=(n=1)=>({id:String(n).padStart(22,'0'),title:'Synthetic fixture',artist:'Fixture artist',imageUrl:null,label:null,audio:{energy:0,happiness:null},isLiked:false});
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(options:{read?:(user:string)=>Promise<unknown>;missing?:boolean;timeoutMs?:number;auth?:(token?:string)=>Promise<{user:{id:string}}|null>}={}){
 const calls:string[]=[],snapshot:ConstellationHistoryProjection={userId:owner,membershipSyncedAt:at,tracks:[row()]};
 const projection:ConstellationReadPort={constellation:async userId=>({userId,tracks:[]})};
 if(!options.missing)projection.constellationHistory=async user=>{calls.push(user);return (options.read?await options.read(user):snapshot) as ConstellationHistoryProjection;};
 const app=Fastify();apps.push(app);
 const module=createTasteConstellationModule({config:{secureCookies:false,webOrigin:'http://localhost:5173',apiOrigin:'http://localhost:3000'},
  auth:{session:options.auth??(async token=>token==='owner'?{user:{id:owner}}:token==='other'?{user:{id:other}}:null)},projection,now:()=>Date.parse(at),readTimeoutMs:options.timeoutMs??1000});
 await app.register(module.registerRoutes);return {app,calls,snapshot,module};
}
const headers={cookie:'sortfm_session=owner'};
function safe(response:{body:string;headers:Record<string,unknown>}){expect(response.headers['cache-control']).toBe('no-store');expect(response.body).not.toContain(owner);expect(response.body).not.toContain('private');}
test('historical constellation preserves unliked training tracks, membership freshness and observed features without predictions',async()=>{
 const f=await setup();f.snapshot.tracks.push({...row(2),label:'keep',isLiked:true},{...row(3),label:'remove'});
 const before=structuredClone(f.snapshot),r=await f.app.inject({url:path,headers});safe(r);expect(r.statusCode).toBe(200);
 expect(r.json()).toMatchObject({schema:'sortfm.constellation.v2',mode:'live',privacy:'evaluation-excluded',generatedAt:at,modelVersion:null,membershipSyncedAt:at});
 expect(r.json().tracks).toEqual(before.tracks.map(t=>({...t,prediction:null})));expect(PUBLIC_ROUTES.constellationHistory.response.safeParse(r.json()).success).toBe(true);
 expect(f.snapshot).toEqual(before);expect(f.calls).toEqual([owner]);
 const v1=await f.app.inject({url:PUBLIC_ROUTES.constellation.path,headers});expect(v1.json()).toMatchObject({schema:'sortfm.constellation.v1',tracks:[]});expect(v1.json()).not.toHaveProperty('membershipSyncedAt');
});
test('history uses authenticated owner and rejects anonymous and foreign-origin reads and selectors before projection',async()=>{
 const f=await setup({read:async userId=>({userId,membershipSyncedAt:null,tracks:[]})});
 for(const cookie of ['', 'sortfm_session=invalid','sortfm_session=owner; sortfm_session=other','sortfm_session=%ZZ'])expect((await f.app.inject({url:path,headers:{cookie}})).statusCode).toBe(401);
 expect((await f.app.inject({url:path,headers:{...headers,origin:'https://foreign.example'}})).statusCode).toBe(403);
 for(const suffix of ['?userId=spotify:other','?limit=1','?modelVersion=x','?mode=synthetic'])expect((await f.app.inject({url:path+suffix,headers})).statusCode).toBe(400);
 for(const bodyHeaders of [{'content-type':'application/json'},{'transfer-encoding':'chunked','content-type':'application/json'}]){
  const r=await f.app.inject({method:'GET',url:path,headers:{...headers,...bodyHeaders},payload:'{}'});expect(r.statusCode).toBe(400);safe(r);
 }
 for(const framing of [{'content-length':'1'},{'transfer-encoding':'chunked'}]){
  const r=await f.app.inject({url:path,headers:{...headers,...framing}});expect(r.statusCode).toBe(400);safe(r);
 }
 expect(f.calls).toEqual([]);
 const r=await f.app.inject({url:path,headers:{cookie:'sortfm_session=other'}});expect(r.statusCode).toBe(200);expect(r.json().tracks).toEqual([]);expect(f.calls).toEqual([other]);
});
test('full snapshot is rejected for wrong owner, duplicate IDs, malformed membership or tracks without partial disclosure',async()=>{
 for(const snapshot of [
  {userId:other,membershipSyncedAt:at,tracks:[row()]},
  {userId:owner,membershipSyncedAt:at,tracks:[row(),row()]},
  {userId:owner,membershipSyncedAt:'invalid',tracks:[row()]},
  {userId:owner,membershipSyncedAt:null,tracks:[row(),{...row(2),isLiked:null}]},
  {userId:owner,membershipSyncedAt:null,tracks:[row(),{...row(2),audio:{energy:NaN}}]},
  {userId:owner,membershipSyncedAt:null,tracks:[row(),{...row(2),prediction:{}}]},
  {userId:owner,membershipSyncedAt:null,tracks:Array.from({length:5001},(_,n)=>row(n+1))},
 ]){
  const f=await setup({read:async()=>snapshot}),r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(503);safe(r);expect(r.body).not.toContain('Synthetic fixture');
 }
});
test('missing history capability, failed privacy dependency and slow auth/projection reads fail closed',async()=>{
 for(const options of [{missing:true},{read:async()=>{throw Error('private evaluation identities');}},{read:()=>new Promise(()=>{}),timeoutMs:5},{auth:()=>new Promise<null>(()=>{}),timeoutMs:5}]){
  const f=await setup(options),r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(503);expect(r.json().code).toBe('CONSTELLATION_UNAVAILABLE');safe(r);
 }
});
test('empty and maximum history snapshots are accepted and refreshed without caching',async()=>{
 const f=await setup();f.snapshot.tracks=[];f.snapshot.membershipSyncedAt=null;
 const empty=await f.app.inject({url:path,headers});expect(empty.statusCode).toBe(200);expect(empty.json()).toMatchObject({membershipSyncedAt:null,tracks:[]});
 f.snapshot.tracks=Array.from({length:5000},(_,n)=>row(n+1));const r=await f.app.inject({url:path,headers});expect(r.statusCode).toBe(200);expect(r.json().tracks).toHaveLength(5000);expect(f.calls).toEqual([owner,owner]);
});
