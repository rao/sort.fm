import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database,migrate,PostgresA1Store,PostgresCalibrationStore,Repository} from '@sortfm/db';
import {AccountSessionSchema,CalibrationBatchReadSchema,CalibrationBatchSchema,CalibrationLabelResultSchema,CalibrationQueueResultSchema,FEATURE_VERSION,FitRequestSchema,FitResponseSchema,PlaybackConnectionStatusSchema,type CalibrationBatch,type ExposureInput,type FitRequest} from '@sortfm/contracts';
import {untrainedPrediction} from '@sortfm/contracts/fixtures';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';
import {PlaybackTransport} from '../src/playback';
import {assembleLibraryCandidates,createMlClient} from '../src/ml';
import {feedbackSplit} from '../src/ml/features';
import {row} from '../src/calibration/test-fixtures';

const databaseUrl=process.env.TEST_DATABASE_URL;
const owner='controlled.batch-runtime',userId=`spotify:${owner}`;
const webOrigin='http://127.0.0.1:5173';
const rightsBasis='Authored controlled Batch2 runtime fixtures';
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
function environment(schema:string,ml?:{serviceUrl:string;sharedSecret:string}){
 return {NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema,PUBLIC_WEB_ORIGIN:webOrigin,
  SPOTIFY_CLIENT_ID:'controlled-batch-client',SPOTIFY_ALLOWED_USER_IDS:owner,
  TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,29).toString('base64'),SESSION_SECRET:'controlled-batch-runtime-test-only-'.repeat(3),
  METADATA_RIGHTS_BASIS:rightsBasis,...(ml?{ML_SERVICE_URL:ml.serviceUrl,ML_SERVICE_SHARED_SECRET:ml.sharedSecret}:{})};
}
function controlledProvider(){
 const calls:{path:string;method:string}[]=[];
 const fetch=async(url:string,init?:RequestInit)=>{
  const path=new URL(url).pathname,method=init?.method??'GET';calls.push({path,method});
  if(path==='/api/token'&&method==='POST')return Response.json({access_token:'controlled-batch-access',refresh_token:'controlled-batch-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private'});
  if(path==='/v1/me'&&method==='GET')return Response.json({id:owner,display_name:'Controlled Batch Owner',images:[]});
  throw Error('Unexpected provider request in calibration-only runtime');
 };
 return {calls,fetch,http:new SpotifyHttp({fetch}),playback:new PlaybackTransport({fetch})};
}
async function login(base:string){
 const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});expect(start.status).toBe(302);
 const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
 const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state,code:'controlled-code'})}`,{redirect:'manual',headers:{cookie:start.headers.get('set-cookie')!.split(';')[0]!}});
 expect(callback.status).toBe(302);
 const cookie=callback.headers.getSetCookie().find(value=>value.startsWith('sortfm_session='))!.split(';')[0]!;
 const account=AccountSessionSchema.parse(await(await fetch(`${base}/api/me`,{headers:{cookie}})).json());
 expect(account.user?.id).toBe(userId);expect(account.capabilities.spotifyWrite).toBe(false);
 return cookie;
}
function requests(base:string,cookie:string){
 const headers={cookie,origin:webOrigin,'content-type':'application/json'};
 const get=(path:string)=>fetch(base+path,{headers,signal:AbortSignal.timeout(30_000)});
 const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});
 return {get,post};
}
async function readBatch(get:ReturnType<typeof requests>['get']){
 const result=await get('/api/calibration/batch2');expect(result.status).toBe(200);
 return CalibrationBatchReadSchema.parse(await result.json()).batch;
}
async function seedLibrary(db:Database,count:number){
 const repository=new Repository(db),at=new Date().toISOString();
 await repository.upsertUser({id:userId,spotifyId:owner,displayName:'Controlled Batch Owner',avatarUrl:null},true);
 // Identical observed model features with balanced labels give actual C1
 // ambiguous predictions; no score or trained-model response is fabricated.
 const tracks=Array.from({length:count},(_,index)=>({...row(index+1).track,durationMs:180000,originalAddedAt:'2020-01-01T00:00:00.000Z',releaseDate:'2019'}));
 await repository.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:at,currentStatus:'saved' as const})));
 await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:tracks.map(track=>track.trackId),sourceTotal:count,observedAt:at}));
 return repository;
}
async function unchangedLibrary(db:Database){
 return db.transaction(async tx=>{
  const result:Record<string,unknown>={};
  for(const table of ['saved_tracks','library_state','library_membership'])result[table]=await tx.unsafe(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY to_jsonb(t)::text`);
  return result;
 });
}
async function noCleanupWork(db:Database){
 const [counts]=await db.transaction(tx=>tx`SELECT (SELECT count(*)::int FROM review_decisions) AS decisions,(SELECT count(*)::int FROM review_work) AS work,(SELECT count(*)::int FROM spotify_mutations) AS mutations,(SELECT count(*)::int FROM undo_commands) AS undos`);
 expect(counts).toEqual({decisions:0,work:0,mutations:0,undos:0});
}
async function migrationsBefore015(db:Database){
 const directory=join(import.meta.dir,'../../../packages/db/migrations');
 await db.sql.unsafe(`CREATE SCHEMA "${db.schema}"`);
 await db.transaction(async tx=>{
  await tx`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
  for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')&&name<'015').sort()){
   const body=await readFile(join(directory,name),'utf8');await tx.unsafe(body);
   await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${createHash('sha256').update(body).digest('hex')})`;
  }
 });
}

test.skipIf(!databaseUrl)('missing 015 gates only batch HTTP routes while ordinary calibration and playback remain usable',async()=>{
 const db=new Database(databaseUrl!,`test_batch_runtime_gate_${crypto.randomUUID().replaceAll('-','')}`),provider=controlledProvider();
 let runtime:Runtime|undefined;
 try{
  await migrationsBefore015(db);await seedLibrary(db,3);
  runtime=await buildRuntime({env:environment(db.schema),spotifyHttp:provider.http,spotifyMutationFetch:provider.fetch,playbackTransport:provider.playback});
  expect(runtime.startupIssues).toEqual(['CALIBRATION_BATCH_DATABASE_UNAVAILABLE']);
  const base=await runtime.app.listen({host:'127.0.0.1',port:0}),cookie=await login(base),{get,post}=requests(base,cookie);
  expect((await(await get('/api/health')).json() as any).capabilities).toMatchObject({database:true,spotify:true});
  for(const response of [await get('/api/calibration/batch2'),await post('/api/calibration/batch2',{seed:42}),await post('/api/calibration/batch2/skip',{exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()})]){
   expect(response.status).toBe(503);expect(await response.json()).toMatchObject({code:'BATCH_UNAVAILABLE',retryable:true});expect(response.headers.get('cache-control')).toContain('no-store');
  }
  const before=await unchangedLibrary(db),queue=CalibrationQueueResultSchema.parse(await(await get('/api/calibration/queue?limit=1')).json()),item=queue.items[0]!;
  const label=CalibrationLabelResultSchema.parse(await(await post('/api/calibration/labels',{trackId:item.track.trackId,exposureId:item.exposure.exposureId,label:0,idempotencyKey:crypto.randomUUID()})).json());
  expect(label.state).toBe('active');
  const undo=await post(`/api/calibration/labels/${label.labelId}/undo`,{idempotencyKey:crypto.randomUUID()});expect(undo.status).toBe(200);expect(CalibrationLabelResultSchema.parse(await undo.json()).state).toBe('revoked');
  expect(PlaybackConnectionStatusSchema.parse(await(await get('/api/player/connection')).json())).toMatchObject({status:'reconnect_required',sdkReady:false,controlReady:false});
  expect((await get('/api/library/summary')).status).toBe(200);expect((await get('/api/calibration/history')).status).toBe(200);
  expect(await unchangedLibrary(db)).toEqual(before);await noCleanupWork(db);
  expect(provider.calls).toEqual([{path:'/api/token',method:'POST'},{path:'/v1/me',method:'GET'}]);
 }finally{await runtime?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},90_000);

async function temporaryC1(){
 const directory=await mkdtemp(join(tmpdir(),'sortfm-batch-runtime-ml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});
 const port=reservation.port!;await reservation.stop(true);
 const origin=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const process=Bun.spawn(['uv','run','--no-sync','--directory',join(import.meta.dir,'../../../services/ml'),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{
  env:{PATH:globalThis.process.env.PATH,HOME:globalThis.process.env.HOME,UV_CACHE_DIR:'/tmp/sortfm-uv-cache',ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe',
 });
 // Drain bounded test-process diagnostics without leaking configuration on failure.
 const diagnostics=new Response(process.stderr).text();
 const calls:string[]=[],fits:FitRequest[]=[];let unavailable=false;
 // This loopback recorder forwards every successful response from actual C1.
 // The outage switch only returns a transport failure; it never invents scores.
 const proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  const path=new URL(request.url).pathname;calls.push(path);
  if(unavailable)return Response.json({code:'CONTROLLED_ML_OUTAGE'},{status:503});
  const body=request.method==='GET'?undefined:await request.text();
  if(path==='/fit')fits.push(FitRequestSchema.parse(JSON.parse(body!)));
  return fetch(origin+new URL(request.url).pathname+new URL(request.url).search,{method:request.method,headers:request.headers,body,signal:AbortSignal.timeout(30_000)});
 }});
 const close=async()=>{await proxy.stop(true);process.kill('SIGTERM');await process.exited;await diagnostics;await rm(directory,{recursive:true,force:true});};
 try{
  let ready=false;const deadline=Date.now()+30_000;
  while(Date.now()<deadline){
   if(process.exitCode!==null)throw Error('Controlled C1 exited before readiness');
   ready=Boolean((await fetch(`${origin}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);
   if(ready)break;await Bun.sleep(100);
  }
  expect(ready).toBe(true);
  const serviceUrl=`http://127.0.0.1:${proxy.port}`;
  return {serviceUrl,sharedSecret,calls,fits,client:createMlClient({serviceUrl,sharedSecret}),outage:()=>{unavailable=true;},close};
 }catch(error){await close();throw error;}
}

async function seedTraining(db:Database,repository:Repository){
 const store=new PostgresCalibrationStore(db),at=new Date(Date.now()-1000).toISOString();
 const candidates=assembleLibraryCandidates(await repository.library(userId),{userId,now:at,metadataTraining:{permittedForTraining:true,rightsBasis}});
 const chosen=[...candidates.filter(c=>feedbackSplit(userId,c.trackId)==='train').slice(0,24),...candidates.filter(c=>feedbackSplit(userId,c.trackId)==='holdout').slice(0,8)];
 expect(chosen).toHaveLength(32);
 for(const [position,candidate] of chosen.entries()){
  const e:ExposureInput={userId,features:candidate.features,prediction:untrainedPrediction,exposure:{exposureId:crypto.randomUUID(),trackId:candidate.trackId,policy:'balanced',selectionMethod:'deterministic_baseline',policyVersion:'controlled-bootstrap',explorationCoefficient:0,propensityEstimate:null,modelVersion:untrainedPrediction.modelVersion,featureVersion:FEATURE_VERSION,removalScore:null,heuristicScore:null,uncertainty:null,position,servedAt:at}};
  await store.insertCalibrationExposure(e);
  const request={trackId:candidate.trackId,exposureId:e.exposure.exposureId,label:(position%2) as 0|1,idempotencyKey:createIdempotencyKey()};
  await store.createCalibrationLabel({userId,labelId:crypto.randomUUID(),request,requestFingerprint:crypto.randomUUID(),createdAt:new Date().toISOString()});
 }
 const snapshot=await repository.trainingExamples(userId);
 expect(snapshot.feedbackRevision).toBe(32);expect(snapshot.examples.filter(e=>e.split==='train')).toHaveLength(24);expect(snapshot.examples.filter(e=>e.split==='holdout')).toHaveLength(8);
}

async function feedbackSettled(db:Database,revision:number){
 let settled=false;const deadline=Date.now()+20_000;
 while(Date.now()<deadline){
  const [job]=await db.transaction(tx=>tx`SELECT target_revision,acknowledged_revision,lease_id FROM feedback_sync_jobs WHERE user_id=${userId}`);
  if(Number(job?.target_revision)===revision&&Number(job?.acknowledged_revision)===revision&&job?.lease_id===null){settled=true;break;}
  await Bun.sleep(100);
 }
 expect(settled).toBe(true);
}

test.skipIf(!databaseUrl)('batch HTTP lifecycle freezes real C1 scores, excludes sealed outcomes from fit/evaluation and resumes without ML',async()=>{
 const db=new Database(databaseUrl!,`test_batch_runtime_live_${crypto.randomUUID().replaceAll('-','')}`),provider=controlledProvider();
 let runtime:Runtime|undefined,c1:Awaited<ReturnType<typeof temporaryC1>>|undefined;
 try{
  await migrate(db);const repository=await seedLibrary(db,160);await seedTraining(db,repository);
  const before=await unchangedLibrary(db);c1=await temporaryC1();
  const start=async(useMl:boolean)=>{
   runtime=await buildRuntime({env:environment(db.schema,useMl?c1:undefined),spotifyHttp:provider.http,spotifyMutationFetch:provider.fetch,playbackTransport:provider.playback});
   expect(runtime.startupIssues).toEqual([]);
   return runtime.app.listen({host:'127.0.0.1',port:0});
  };
  let base=await start(true);const cookie=await login(base);let {get,post}=requests(base,cookie);
  await feedbackSettled(db,32);
  const fit=async(labels:number,train:number)=>{
   const response=await post('/api/ml/retrain',{});expect(response.status).toBe(200);
   const result=FitResponseSchema.parse(await response.json());
   expect(result.metrics).toMatchObject({labeledExamples:labels,trainedExamples:train,heldOutExamples:8});
   expect(await c1!.client.evaluation({userId})).toEqual(result.metrics);
   return result;
  };
  const initial=await fit(32,24);
  expect(await readBatch(get)).toBeNull();
  for(const [path,method,body] of [['/api/calibration/batch2','GET',undefined],['/api/calibration/batch2','POST',{seed:42}],['/api/calibration/batch2/skip','POST',{exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()}]] as const){
   const response=await fetch(base+path,{method,headers:{origin:webOrigin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
   expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toContain('no-store');expect(response.headers.get('access-control-allow-origin')).toBe(webOrigin);expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  }
  expect((await fetch(base+'/api/calibration/batch2',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{"seed":42}'})).status).toBe(403);
  expect((await post('/api/calibration/batch2',{seed:42,userId:'other-owner'})).status).toBe(400);
  expect((await fetch(base+'/api/calibration/batch2',{headers:{cookie,origin:'https://untrusted.invalid'}})).status).toBe(403);

  const created=await post('/api/calibration/batch2',{seed:42});expect(created.status).toBe(200);
  const batch=CalibrationBatchSchema.parse(await created.json());
  expect(batch).toMatchObject({candidateCount:128,target:70,labeled:0,trainingLabeled:0,sealedLabeled:0,modelVersion:initial.modelVersion});
  expect(batch.groups.map(group=>[group.group,group.target,group.pending])).toEqual([['A',25,25],['B',25,25],['C',20,20]]);
  expect(new Set(batch.entries.map(entry=>entry.trackId)).size).toBe(70);
  expect(batch.queue.items.every(item=>item.prediction.modelKind==='logistic'&&item.prediction.removalProbability!==null)).toBe(true);
  const scoresAfterCreation=c1.calls.filter(path=>path==='/score').length;
  expect(scoresAfterCreation).toBe(1);
  expect(CalibrationBatchSchema.parse(await(await post('/api/calibration/batch2',{seed:42})).json())).toEqual(batch);
  expect(await readBatch(get)).toEqual(batch);
  expect((await post('/api/calibration/batch2',{seed:43})).status).toBe(409);
  const [frozen]=await db.transaction(tx=>tx`SELECT snapshot FROM calibration_batches WHERE user_id=${userId}`);
  expect(frozen.snapshot.candidates.every((candidate:any)=>candidate.features.permittedForTraining&&candidate.features.rightsBasis===`Metadata: ${rightsBasis}`)).toBe(true);
  const a=batch.entries.find(entry=>entry.group==='A')!,b=batch.entries.find(entry=>entry.group==='B')!,c=batch.entries.find(entry=>entry.group==='C')!;
  const label=async(entry:CalibrationBatch['entries'][number],value:0|1)=>{
   const request={trackId:entry.trackId,exposureId:entry.exposureId,label:value,idempotencyKey:crypto.randomUUID()};
   const response=await post('/api/calibration/labels',request);expect(response.status).toBe(200);
   const saved=CalibrationLabelResultSchema.parse(await response.json());
   expect(saved.state).toBe('active');expect(CalibrationLabelResultSchema.parse(await(await post('/api/calibration/labels',request)).json())).toEqual(saved);
   return saved;
  };
  const sealed=await label(a,1);await feedbackSettled(db,sealed.feedbackRevision);
  expect((await c1.client.evaluation({userId})).labeledExamples).toBe(32);await fit(32,24);
  const trained=await label(b,0),uncertain=await label(c,1);await feedbackSettled(db,uncertain.feedbackRevision);await fit(34,26);
  expect((await readBatch(get))!).toMatchObject({labeled:3,trainingLabeled:2,sealedLabeled:1});
  expect((await repository.trainingExamples(userId)).examples.some(example=>example.trackId===a.trackId)).toBe(false);
  const skipItem=batch.entries.find(entry=>entry.group==='A'&&entry.batchItemId!==a.batchItemId)!,skipRequest={exposureId:skipItem.exposureId,idempotencyKey:crypto.randomUUID()};
  const skipped=CalibrationBatchSchema.parse(await(await post('/api/calibration/batch2/skip',skipRequest)).json());
  expect(skipped.entries.find(entry=>entry.batchItemId===skipItem.batchItemId)?.status).toBe('skipped');
  expect(skipped.entries.find(entry=>entry.replacementFor===skipItem.batchItemId)).toMatchObject({group:'A',assignment:'sealed_evaluation',status:'pending'});
  expect(skipped.entries).toHaveLength(71);expect(skipped.labeled).toBe(3);
  expect(CalibrationBatchSchema.parse(await(await post('/api/calibration/batch2/skip',skipRequest)).json())).toEqual(skipped);
  expect((await post('/api/calibration/batch2/skip',{...skipRequest,exposureId:a.exposureId})).status).toBe(409);
  expect((await repository.trainingExamples(userId)).feedbackRevision).toBe(35);
  const undoRequest={idempotencyKey:crypto.randomUUID()},undoPath=`/api/calibration/labels/${trained.labelId}/undo`;
  const undone=CalibrationLabelResultSchema.parse(await(await post(undoPath,undoRequest)).json());
  expect(undone.state).toBe('revoked');await feedbackSettled(db,undone.feedbackRevision);await fit(33,25);
  expect(CalibrationLabelResultSchema.parse(await(await post(undoPath,undoRequest)).json())).toEqual(undone);
  const renewed=(await readBatch(get))!.entries.find(entry=>entry.batchItemId===b.batchItemId)!;
  expect(renewed).toMatchObject({...b,status:'revoked',exposureId:renewed.exposureId});expect(renewed.exposureId).not.toBe(b.exposureId);
  const renewedSnapshot=await repository.getExposure(userId,renewed.exposureId),originalSnapshot=await repository.getExposure(userId,b.exposureId);
  expect(renewedSnapshot?.features).toEqual(originalSnapshot?.features);expect(renewedSnapshot?.prediction).toEqual(originalSnapshot?.prediction);
  expect(Date.parse(renewedSnapshot!.exposure.servedAt)).toBeGreaterThan(Date.parse(undone.updatedAt));
  const relabeled=await label(renewed,0);await feedbackSettled(db,relabeled.feedbackRevision);await fit(34,26);
  const sealedUndo=CalibrationLabelResultSchema.parse(await(await post(`/api/calibration/labels/${sealed.labelId}/undo`,{idempotencyKey:crypto.randomUUID()})).json());
  await feedbackSettled(db,sealedUndo.feedbackRevision);await fit(34,26);
  const resumed=(await readBatch(get))!,renewedA=resumed.entries.find(entry=>entry.batchItemId===a.batchItemId)!;
  expect(renewedA).toMatchObject({assignment:'sealed_evaluation',status:'revoked',trackId:a.trackId});expect(renewedA.exposureId).not.toBe(a.exposureId);
  const sealedIds=new Set(resumed.entries.filter(entry=>entry.assignment==='sealed_evaluation').map(entry=>entry.trackId));
  expect(c1.fits.length).toBeGreaterThan(5);expect(c1.fits.every(request=>request.examples.every(example=>!sealedIds.has(example.trackId)))).toBe(true);
  expect(c1.calls.filter(path=>path==='/score')).toHaveLength(scoresAfterCreation);
  expect(resumed.modelVersion).toBe(initial.modelVersion);expect(resumed.queue.items.every(item=>item.prediction.modelVersion===initial.modelVersion)).toBe(true);
  const ordinary=CalibrationQueueResultSchema.parse(await(await get('/api/calibration/queue?limit=1')).json());
  expect(ordinary.items).toHaveLength(1);expect(resumed.entries.some(entry=>entry.trackId===ordinary.items[0]!.track.trackId)).toBe(false);
  expect(PlaybackConnectionStatusSchema.parse(await(await get('/api/player/connection')).json())).toMatchObject({status:'reconnect_required',sdkReady:false,controlReady:false});
  expect(await unchangedLibrary(db)).toEqual(before);await noCleanupWork(db);
  expect(c1.calls.every(path=>['/fit','/score','/evaluation'].includes(path))).toBe(true);
  expect(provider.calls).toEqual([{path:'/api/token',method:'POST'},{path:'/v1/me',method:'GET'}]);

  c1.outage();const callsBeforeOutage=c1.calls.length;
  expect(await readBatch(get)).toEqual(resumed);
  expect(CalibrationBatchSchema.parse(await(await post('/api/calibration/batch2',{seed:42})).json())).toEqual(resumed);
  expect(c1.calls).toHaveLength(callsBeforeOutage);
  await runtime!.close();runtime=undefined;base=await start(false);({get,post}=requests(base,cookie));
  expect(await readBatch(get)).toEqual(resumed);
  expect(CalibrationBatchSchema.parse(await(await post('/api/calibration/batch2',{seed:42})).json())).toEqual(resumed);
  expect(PlaybackConnectionStatusSchema.parse(await(await get('/api/player/connection')).json()).status).toBe('reconnect_required');
  expect(c1.calls).toHaveLength(callsBeforeOutage);
  expect(await unchangedLibrary(db)).toEqual(before);await noCleanupWork(db);
 }finally{await runtime?.close();await c1?.close();await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},180_000);
