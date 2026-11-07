import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMlClient} from '../src/ml';
import {Database,migrate,Repository} from '@sortfm/db';
import {QueueResultSchema,AccountSessionSchema,LibraryImportStatusSchema,ReviewRequestSchema,ReviewResultSchema,DecisionHistorySchema,type ReviewResult} from '@sortfm/contracts';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';

const databaseUrl=process.env.TEST_DATABASE_URL;

test.skipIf(!databaseUrl)('HTTP import, scored queue, all review actions and Undo reconcile Tiger/C1 with outage fallback',async()=>{
 const schema=`test_backend_${crypto.randomUUID().replaceAll('-','')}`;
 const db=new Database(databaseUrl!,schema);
 const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-backend-ml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});
 const port=reservation.port!;await reservation.stop(true);
 const serviceUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const worker=Bun.spawn(['uv','run','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir},stdout:'ignore',stderr:'pipe'});
 const ml=createMlClient({serviceUrl,sharedSecret});
 let runtime:Awaited<ReturnType<typeof buildRuntime>>|undefined;
 const tracks=[1,2,3,4].map(n=>({added_at:'2020-01-01T00:00:00Z',track:{id:String(n).padStart(22,'0'),name:`Controlled backend track ${n}`,duration_ms:120000,is_playable:true,artists:[{id:`artist-${n}`,name:`Controlled Artist ${n}`}],album:{name:'Controlled album',release_date:'2019-01-01',images:[]}}}));
 const liked=new Set(tracks.map(row=>row.track.id)),archived=new Set<string>(),writes:string[]=[];
 const playlistId='0000000000000000000099';let playlistCreated=false;
 const playlist={id:playlistId,public:false,owner:{id:'controlled.owner'},description:'sort.fm archive [sortfm:controlled.owner]'};
 const provider=async(url:string,init?:RequestInit)=>{
  const parsed=new URL(url),method=init?.method??'GET',trackId=parsed.searchParams.get('uris')?.split(':').at(-1)!;
  if(url.includes('/api/token'))return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-read-recently-played user-library-modify playlist-modify-private playlist-read-private'});
  if(url.endsWith('/me'))return Response.json({id:'controlled.owner',display_name:'Controlled backend account',images:[]});
  if(url.includes('recently-played'))return Response.json({items:[]});
  if(url.includes('/me/tracks'))return Response.json({offset:0,limit:50,total:tracks.length,next:null,items:tracks});
  if(parsed.pathname==='/v1/me/library/contains')return Response.json([liked.has(trackId)]);
  if(parsed.pathname==='/v1/me/library'){
   writes.push(`${method}:${trackId}`);if(method==='DELETE')liked.delete(trackId);else if(method==='PUT')liked.add(trackId);else throw new Error('Unexpected library method');
   return new Response(null,{status:200});
  }
  if(parsed.pathname==='/v1/me/playlists'){
   if(method==='POST'){playlistCreated=true;writes.push('CREATE_ARCHIVE');return Response.json(playlist);}
   return Response.json({offset:0,total:playlistCreated?1:0,items:playlistCreated?[playlist]:[]});
  }
  if(parsed.pathname===`/v1/playlists/${playlistId}`)return Response.json(playlist);
  if(parsed.pathname===`/v1/playlists/${playlistId}/items`){
   if(method==='POST'){const id=JSON.parse(init!.body as string).uris[0].split(':').at(-1);archived.add(id);writes.push(`ARCHIVE:${id}`);return Response.json({snapshot_id:'controlled-snapshot'});}
   return Response.json({offset:0,total:archived.size,items:[...archived].map(id=>({item:{id,type:'track'}}))});
  }
  throw new Error('Unexpected controlled-provider request');
 };
 const http=new SpotifyHttp({fetch:provider});
 try {
  await migrate(db);
  const startupDeadline=Date.now()+30_000;let ready=false;
  while(Date.now()<startupDeadline){
   if(worker.exitCode!==null)throw new Error('Controlled ML worker exited before readiness');
   ready=Boolean((await fetch(`${serviceUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);
   if(ready)break;await Bun.sleep(100);
  }
  expect(ready).toBe(true);
  runtime=await buildRuntime({env:{NODE_ENV:'test',ML_SERVICE_URL:serviceUrl,ML_SERVICE_SHARED_SECRET:sharedSecret,METADATA_RIGHTS_BASIS:'Authored controlled integration fixtures; no real-user efficacy claim',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema,SPOTIFY_CLIENT_ID:'controlled-client',SPOTIFY_ALLOWED_USER_IDS:'controlled.owner',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),SESSION_SECRET:'controlled-backend-test-only-'.repeat(3)},spotifyHttp:http,spotifyMutationFetch:provider});
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
  expect(session.capabilities.spotifyWrite).toBe(true);
  const sync=await fetch(`${base}/api/library/sync`,{method:'POST',headers:{cookie:sessionCookie,origin:'http://127.0.0.1:5173','content-type':'application/json'},body:'{}'});
  expect(sync.status).toBe(202);
  let status=LibraryImportStatusSchema.parse(await sync.json());
  const deadline=Date.now()+25_000;
  while(status.status!=='complete'&&status.status!=='failed'&&Date.now()<deadline){
   await Bun.sleep(100);
   status=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers:{cookie:sessionCookie}})).json());
  }
  expect(status.status).toBe('complete');expect(status.processed).toBe(4);
  const result=await fetch(`${base}/api/queue?limit=4`,{headers:{cookie:sessionCookie}});
  expect(result.status).toBe(200);
  const queue=QueueResultSchema.parse(await result.json());
  expect(queue.mode).toBe('spotify');expect(queue.items).toHaveLength(4);expect(queue.remaining).toBe(4);
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
  // Actual authenticated public routes and automatic workers; no direct settlement/fit.
  const userId=session.user!.id,headers={cookie:sessionCookie,origin:'http://127.0.0.1:5173','content-type':'application/json'};
  const awaitDecision=async(id:string,expected:'COMPLETE'|'UNDONE')=>{
   const until=Date.now()+25_000;let result:ReviewResult|undefined;
   while(Date.now()<until){
    const history=DecisionHistorySchema.parse(await(await fetch(`${base}/api/decisions/history`,{headers})).json());
    result=history.items.find(row=>row.decisionId===id);
    if(result?.status===expected)break;
    if(result?.status==='FAILED_TERMINAL')throw new Error(`Controlled action failed: ${result.error?.code}`);
    await Bun.sleep(100);
   }
   expect(result?.status).toBe(expected);return result!;
  };
  const awaitFeedback=async(revision:number,labels:number)=>{
   const until=Date.now()+15_000;let acknowledged=false;
   while(Date.now()<until){
    const rows=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);
    if(Number(rows[0]?.acknowledged_revision)===revision){acknowledged=true;break;}
    await Bun.sleep(100);
   }
   expect(acknowledged).toBe(true);
   expect((await ml.evaluation({userId})).labeledExamples).toBe(labels);
  };
  let labels=0;const decisions:ReviewResult[]=[];
  for(const [index,action] of (['KEEP','SKIP','ARCHIVE','UNLIKE'] as const).entries()){
   const item=queue.items[index]!,request=ReviewRequestSchema.parse({trackId:item.track.trackId,action,exposureId:item.exposure.exposureId,idempotencyKey:crypto.randomUUID()});
   const response=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify(request)});
   expect(response.status).toBe(202);const pending=ReviewResultSchema.parse(await response.json());
   const complete=await awaitDecision(pending.decisionId,'COMPLETE');decisions.push(complete);
   expect(complete.label).toBe(action==='SKIP'?null:action==='KEEP'?0:1);
   if(action!=='SKIP')labels++;
   await awaitFeedback(complete.feedbackRevision,labels);
   const repeated=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify(request)});
   expect(repeated.status).toBe(200);expect(ReviewResultSchema.parse(await repeated.json()).decisionId).toBe(complete.decisionId);
   expect(liked.has(item.track.trackId)).toBe(action==='KEEP'||action==='SKIP');
  }
  const archiveTrack=decisions[2]!.trackId;
  expect(writes.indexOf(`ARCHIVE:${archiveTrack}`)).toBeLessThan(writes.indexOf(`DELETE:${archiveTrack}`));
  expect((await repository.library(userId)).map(row=>row.track.trackId)).toHaveLength(2);
  for(const decision of [...decisions].reverse()){
   const url=`${base}/api/decisions/${decision.decisionId}/undo`,body=JSON.stringify({idempotencyKey:crypto.randomUUID()});
   const pending=await fetch(url,{method:'POST',headers,body});expect(pending.status).toBe(409);expect((await pending.json() as {code:string}).code).toBe('UNDO_PENDING');
   const undone=await awaitDecision(decision.decisionId,'UNDONE');expect(undone.labelState).toBe('revoked');
   if(decision.action!=='SKIP')labels--;
   await awaitFeedback(undone.feedbackRevision,labels);
   const repeated=await fetch(url,{method:'POST',headers,body});expect(repeated.status).toBe(200);
   expect(liked.has(decision.trackId)).toBe(true);
  }
  expect((await repository.library(userId)).map(row=>row.track.trackId)).toHaveLength(4);
  expect(writes.filter(value=>value.startsWith('DELETE:'))).toHaveLength(2);
  expect(writes.filter(value=>value.startsWith('ARCHIVE:'))).toHaveLength(1);
  expect(archived.has(archiveTrack)).toBe(true);
  const events:{event_type:string}[]=await db.transaction(tx=>tx`SELECT event_type FROM interaction_events WHERE user_id=${userId}`);
  expect(events.filter(row=>row.event_type==='decision')).toHaveLength(4);expect(events.filter(row=>row.event_type==='undo')).toHaveLength(4);
  const fresh=QueueResultSchema.parse(await(await fetch(`${base}/api/queue?limit=4`,{headers})).json());
  expect(fresh.items).toHaveLength(4);expect(fresh.items.every(item=>!queue.items.some(old=>old.exposure.exposureId===item.exposure.exposureId))).toBe(true);
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
},180_000);
