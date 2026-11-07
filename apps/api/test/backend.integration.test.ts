import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMlClient} from '../src/ml';
import {Database,migrate,Repository} from '@sortfm/db';
import {QueueResultSchema,AccountSessionSchema,LibraryImportStatusSchema} from '@sortfm/contracts';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';

const databaseUrl=process.env.TEST_DATABASE_URL;

test.skipIf(!databaseUrl)('HTTP OAuth/import reach Tiger and real C1 scoring with missing-audio and ML outage fallback',async()=>{
 const schema=`test_backend_${crypto.randomUUID().replaceAll('-','')}`;
 const db=new Database(databaseUrl!,schema);
 const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-backend-ml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});
 const port=reservation.port!;await reservation.stop(true);
 const serviceUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const worker=Bun.spawn(['uv','run','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir},stdout:'ignore',stderr:'pipe'});
 const ml=createMlClient({serviceUrl,sharedSecret});
 let runtime:Awaited<ReturnType<typeof buildRuntime>>|undefined;
 const tracks=[1,2,3].map(n=>({added_at:'2020-01-01T00:00:00Z',track:{id:String(n).padStart(22,'0'),name:`Controlled backend track ${n}`,duration_ms:120000,is_playable:true,artists:[{id:`artist-${n}`,name:`Controlled Artist ${n}`}],album:{name:'Controlled album',release_date:'2019-01-01',images:[]}}}));
 const http=new SpotifyHttp({fetch:async url=>{
  if(url.includes('/api/token'))return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-read-recently-played'});
  if(url.endsWith('/me'))return Response.json({id:'controlled.owner',display_name:'Controlled backend account',images:[]});
  if(url.includes('recently-played'))return Response.json({items:[]});
  if(url.includes('/me/tracks'))return Response.json({offset:0,limit:50,total:tracks.length,next:null,items:tracks});
  throw new Error('Unexpected controlled-provider request');
 }});
 try {
  await migrate(db);
  const startupDeadline=Date.now()+30_000;let ready=false;
  while(Date.now()<startupDeadline){
   if(worker.exitCode!==null)throw new Error('Controlled ML worker exited before readiness');
   ready=Boolean((await fetch(`${serviceUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);
   if(ready)break;await Bun.sleep(100);
  }
  expect(ready).toBe(true);
  runtime=await buildRuntime({env:{NODE_ENV:'test',ML_SERVICE_URL:serviceUrl,ML_SERVICE_SHARED_SECRET:sharedSecret,METADATA_RIGHTS_BASIS:'Authored controlled integration fixtures; no real-user efficacy claim',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema,SPOTIFY_CLIENT_ID:'controlled-client',SPOTIFY_ALLOWED_USER_IDS:'controlled.owner',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),SESSION_SECRET:'controlled-backend-test-only-'.repeat(3)},spotifyHttp:http});
  expect(runtime.startupIssues).toEqual([]);
  const base=await runtime.app.listen({host:'127.0.0.1',port:0});
  const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});
  expect(start.status).toBe(302);
  const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
  const oauthCookie=start.headers.get('set-cookie')!.split(';')[0]!;
  const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state,code:'controlled-code'})}`,{headers:{cookie:oauthCookie},redirect:'manual'});
  expect(callback.status).toBe(302);
  const sessionCookie=callback.headers.getSetCookie().find(value=>value.startsWith('sortfm_session='))!.split(';')[0]!;
  const session=AccountSessionSchema.parse(await(await fetch(`${base}/api/me`,{headers:{cookie:sessionCookie}})).json());
  expect(session.mode).toBe('spotify');expect(session.user?.spotifyId).toBe('controlled.owner');
  const sync=await fetch(`${base}/api/library/sync`,{method:'POST',headers:{cookie:sessionCookie,origin:'http://127.0.0.1:5173','content-type':'application/json'},body:'{}'});
  expect(sync.status).toBe(202);
  let status=LibraryImportStatusSchema.parse(await sync.json());
  const deadline=Date.now()+25_000;
  while(status.status!=='complete'&&status.status!=='failed'&&Date.now()<deadline){
   await Bun.sleep(100);
   status=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers:{cookie:sessionCookie}})).json());
  }
  expect(status.status).toBe('complete');expect(status.processed).toBe(3);
  const result=await fetch(`${base}/api/queue?limit=3`,{headers:{cookie:sessionCookie}});
  expect(result.status).toBe(200);
  const queue=QueueResultSchema.parse(await result.json());
  expect(queue.mode).toBe('spotify');expect(queue.items).toHaveLength(3);expect(queue.remaining).toBe(3);
  const repository=new Repository(db);
  const rows=await repository.library(session.user!.id);
  expect(rows.every(row=>row.audioFeatures===null)).toBe(true);
  for(const item of queue.items){
   const stored=await repository.getExposure(session.user!.id,item.exposure.exposureId);
   expect(stored?.prediction).toEqual(item.prediction);
   expect(stored?.features.values.saved_age_days).toBeGreaterThan(0);
   expect(item.prediction.removalProbability).toBeNull();
   expect(item.prediction.modelKind).toBe('heuristic');
   expect(stored?.features.permittedForTraining).toBe(true);
   expect((await ml.explain({userId:session.user!.id,exposureId:item.exposure.exposureId})).prediction).toEqual(item.prediction);
   expect(await repository.getExposure('other-user',item.exposure.exposureId)).toBeNull();
  }
  expect((await fetch(`${base}/api/queue`)).status).toBe(401);
  const demo=QueueResultSchema.parse(await(await fetch(`${base}/api/queue?mode=demo&limit=1`)).json());
  expect(demo.items[0]?.track.source).toBe('synthetic');
  expect((await(await fetch(`${base}/api/health`)).json() as {capabilities:{ml:boolean}}).capabilities.ml).toBe(true);
  expect((await ml.evaluation({userId:session.user!.id})).status).toBe('insufficient_data');
  worker.kill('SIGTERM');await worker.exited;
  const fallback=QueueResultSchema.parse(await(await fetch(`${base}/api/queue?limit=1`,{headers:{cookie:sessionCookie}})).json());
  expect(fallback.items[0]?.prediction.modelVersion).toBe('queue:metadata:v1');
  expect(fallback.items[0]?.prediction.removalProbability).toBeNull();
  expect(fallback.fallbackReason).toContain('unavailable');
  expect((await repository.getExposure(session.user!.id,fallback.items[0]!.exposure.exposureId))?.prediction).toEqual(fallback.items[0]!.prediction);
 } finally {
  await runtime?.close();
  await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.close();
  if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;
  await rm(artifactDir,{recursive:true,force:true});
 }
},90_000);
