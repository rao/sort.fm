import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,migrate,PostgresA1Store,PostgresPolicyStore,Repository} from '@sortfm/db';
import {CALIBRATION_BATCH3_EXPERIMENT as experiment,CalibrationExperimentReadSchema,CalibrationExperimentReadySchema,
 CalibrationLabelResultSchema,CalibrationQueueResultSchema,FitResponseSchema,LibraryImportStatusSchema,QueueResultSchema,
 calibrationExperimentCanonical,calibrationExperimentSeedPrecommit,FitRequestSchema,PolicySelectRequestSchema,
 type CalibrationExperimentSealInput,type CalibrationExperimentSnapshot,type FitRequest,type PolicySelectRequest,
} from '@sortfm/contracts';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {buildRuntime} from '../src/runtime';
import type {CalibrationExperimentReserveInput} from '../src/calibration';
import {SpotifyHttp} from '../src/spotify/http';
import {createMlClient,feedbackSplit} from '../src/ml';

// Explicit opt-in only. Every mutation is confined to a fresh disposable schema.
const databaseUrl=process.env.TEST_DATABASE_URL;
const owner='controlled.batch3.owner',userId=`spotify:${owner}`,origin='http://127.0.0.1:5173';
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
const experimentPath=`/api/calibration/experiments/${experiment}`;

test.skipIf(!databaseUrl)('Batch3 actual API/Postgres/C1: private reserve, sealed A, training B, replay and frozen snapshots',async()=>{
 const db=new Database(databaseUrl!,`test_experiment_backend_${crypto.randomUUID().replaceAll('-','')}`);
 const repository=new Repository(db),policy=new PostgresPolicyStore(db),provider=controlledSpotify();
 let runtime:Runtime|undefined,ml:Awaited<ReturnType<typeof localMl>>|undefined;
 try{
  await migrate(db);ml=await localMl();
  const start=async(strategy:'c1'|'epsilon_greedy'|'linucb'='c1')=>{
   runtime=await buildRuntime({env:{...environment(db),ML_SERVICE_URL:ml!.serviceUrl,ML_SERVICE_SHARED_SECRET:ml!.sharedSecret,
    ...(strategy==='c1'?{}:{C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:strategy})},
    spotifyHttp:new SpotifyHttp({fetch:provider.fetch}),spotifyMutationFetch:provider.fetch});
   expect(runtime.startupIssues).toEqual([]);expect(runtime.calibrationExperiment).not.toBeNull();
   return runtime.app.listen({host:'127.0.0.1',port:0});
  };
  let base=await start();const cookie=await login(base),headers={cookie,origin,'content-type':'application/json'};
  const post=(path:string,body:unknown)=>fetch(`${base}${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const read=async()=>{const response=await fetch(`${base}${experimentPath}`,{headers});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');return CalibrationExperimentReadSchema.parse(await response.json()).batch;};
  const readReady=async()=>CalibrationExperimentReadySchema.parse(await read());
  const label=async(entry:{trackId:string;exposureId:string},value:0|1)=>{
   const request={trackId:entry.trackId,exposureId:entry.exposureId,label:value,idempotencyKey:crypto.randomUUID()};
   const response=await post('/api/calibration/labels',request);expect(response.status).toBe(200);
   return {request,result:CalibrationLabelResultSchema.parse(await response.json())};
  };
  const awaitFit=async(revision:number,trainingCount:number)=>{
   await eventually('committed calibration fit acknowledgement',async()=>{
    const [row]=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);
    return row?.acknowledged_revision===revision;
   });
   const metrics=await ml!.client.evaluation({userId});expect(metrics.trainedExamples).toBe(trainingCount);
   const [receipt]=await db.transaction(tx=>tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`);
   expect(receipt).toEqual({model_version:metrics.modelVersion,feedback_revision:revision});
  };
  expect((await post('/api/library/sync',{})).status).toBe(202);
  await eventually('authored paginated Spotify import',async()=>{
   const status=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers})).json());
   if(status.status==='failed')throw Error('Synthetic import failed');return status.status==='complete'&&status.processed===provider.tracks.length;
  });
  expect((await repository.library(userId))).toHaveLength(108);
  // Twelve authored train-split labels create a real supervised C1 before any
  // experiment candidate capture. The feedback worker uses persisted vectors.
  const initial=CalibrationQueueResultSchema.parse(await(await fetch(`${base}/api/calibration/queue?limit=12`,{headers})).json());
  expect(initial.items).toHaveLength(12);
  let trainingRevision=0;
  for(const [index,item] of initial.items.entries())trainingRevision=(await label({trackId:item.track.trackId,exposureId:item.exposure.exposureId},index%2 as 0|1)).result.feedbackRevision;
  await awaitFit(trainingRevision,12);
  const fittedResponse=await post('/api/ml/retrain',{});expect(fittedResponse.status).toBe(200);
  const fitted=FitResponseSchema.parse(await fittedResponse.json());expect(fitted.trainedExamples).toBe(12);
  const frozenModelFiles=await ml.modelFiles(fitted.modelVersion);expect(Object.keys(frozenModelFiles)).toHaveLength(2);
  const training=await repository.trainingExamples(userId);expect(training.examples.every(e=>e.split==='train')).toBe(true);

  // Private, authored artifact bytes represent an operator precommit, not a
  // research result. Its binding predates the first pool read.
  const batchId=crypto.randomUUID(),protocolVersion='authored-batch3-integration-v1',seed=42;
  const seedBytes=calibrationExperimentSeedPrecommit(batchId,protocolVersion,seed);
  const research={protocolSha256:sha('authored protocol'),trainingDataSha256:digest(training.examples),modelSealSha256:digest(frozenModelFiles)};
  const input:CalibrationExperimentReserveInput={batchId,experiment,protocolVersion,seedPrecommit:{seed,commitment:sha(seedBytes),committedAt:new Date().toISOString(),artifactSha256:sha(seedBytes)},research,
   exclusionLedger:{source:'authored synthetic empty historical ledger',sortedTrackIds:[],sortedIdsSha256:digest([])}};
  const fitCount=ml.fits.length,scoreCount=ml.scores.length,providerCount=provider.calls.length;
  const reservation=await runtime!.calibrationExperiment!.reserve(userId,input);
  const snapshot=(await runtime!.calibrationExperiment!.snapshot(userId,experiment))!;
  expect(snapshot.reservation).toEqual(reservation);expect(snapshot.seal).toBeNull();
  expect(snapshot.draft.candidates).toHaveLength(96);expect(snapshot.draft.modelVersion).toBe(fitted.modelVersion);
  expect(snapshot.draft.candidates.every(c=>c.prediction.modelKind==='logistic'&&c.prediction.trainedExamples===12&&c.features.permittedForTraining)).toBe(true);
  expect(ml.fits).toHaveLength(fitCount);expect(ml.scores).toHaveLength(scoreCount+1);expect(provider.calls).toHaveLength(providerCount);
  expect(await runtime!.calibrationExperiment!.reserve(userId,input)).toEqual(reservation);
  expect(ml.scores).toHaveLength(scoreCount+1);
  await expect(runtime!.calibrationExperiment!.reserve(userId,{...input,research:{...research,protocolSha256:sha('different')}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const reserved=await read();expect(reserved?.phase).toBe('reserved');
  expect(Object.keys(reserved!).sort()).toEqual(['batchId','experiment','groups','phase','reservedAt','target']);
  const items:{trackId:string;exposureId:string;sampling_group:string}[]=await db.transaction(tx=>tx`SELECT track_id AS "trackId",exposure_id AS "exposureId",sampling_group FROM calibration_batch_items WHERE user_id=${userId} ORDER BY position`);
  expect(items).toHaveLength(60);expect(items.filter(i=>i.sampling_group==='A')).toHaveLength(40);
  const panelIds=new Set(items.map(i=>String(i.trackId))),aIds=new Set(snapshot.draft.selected.slice(0,40).map(s=>s.trackId));
  // A browser cannot label any of the sixty, even with a guessed private ID.
  for(const item of items){
   const response=await post('/api/calibration/labels',{trackId:item.trackId,exposureId:item.exposureId,label:0,idempotencyKey:crypto.randomUUID()});
   expect(response.status).toBe(409);expect((await response.json() as {code:string}).code).toBe('BATCH_NOT_READY');
  }
  for(const item of [items[0]!,items[40]!]){
   const response=await post(`${experimentPath}/skip`,{exposureId:item.exposureId,idempotencyKey:crypto.randomUUID()});expect(response.status).toBe(409);expect((await response.json() as {code:string}).code).toBe('BATCH_NOT_READY');
   await expect(repository.getExposure(userId,item.exposureId)).rejects.toMatchObject({code:'BATCH_NOT_READY'});
  }
  // No preseal label exists to Undo; guessing one creates no command or state.
  expect((await post(`/api/calibration/labels/${crypto.randomUUID()}/undo`,{idempotencyKey:crypto.randomUUID()})).status).toBe(404);
  await expect(db.transaction(tx=>tx`UPDATE calibration_batch_items SET status='revoked' WHERE user_id=${userId}`)).rejects.toThrow('BATCH_NOT_READY');
  await expect(db.transaction(tx=>tx`UPDATE calibration_batches SET snapshot='{}'::jsonb WHERE user_id=${userId}`)).rejects.toThrow('BATCH_SNAPSHOT_IMMUTABLE');
  const [admission]=await db.transaction(tx=>tx`SELECT (SELECT count(*)::integer FROM calibration_labels WHERE user_id=${userId}) labels,(SELECT count(*)::integer FROM calibration_undos WHERE user_id=${userId}) undos,(SELECT count(*)::integer FROM calibration_batch_skips WHERE user_id=${userId}) skips`);
  expect(admission).toEqual({labels:12,undos:0,skips:0});expect(await repository.trainingExamples(userId)).toEqual(training);

  // All runtime policy switches consult the same permanent reservations. Real
  // C2 selection receives only eligible nonpanel candidates (cold rewards are OK).
  for(const strategy of ['c1','epsilon_greedy','linucb'] as const){
   await runtime!.close();runtime=undefined;base=await start(strategy);
   expect((await read())?.phase).toBe('reserved');
   const eligible=await policy.reviewCandidates(userId);expect(eligible.eligibleTrackIds.some(id=>panelIds.has(id))).toBe(false);
   const response=await fetch(`${base}/api/queue?limit=1`,{headers});expect(response.status).toBe(200);
   const queue=QueueResultSchema.parse(await response.json());expect(queue.items).toHaveLength(1);expect(panelIds.has(queue.items[0]!.track.trackId)).toBe(false);
   const current=(await policy.currentSelection(userId))!;expect(current.draft.kind).toBe(strategy==='c1'?'c1':'adaptive');
   if(strategy!=='c1'){const request=ml.selects.at(-1)!;expect(request.config.strategy).toBe(strategy);expect(request.candidates.some(c=>panelIds.has(c.trackId))).toBe(false);}
   await policy.releaseSelection({userId,requestId:current.requestId,releaseId:crypto.randomUUID(),exposureIds:current.publication!.items.map(i=>i.exposure.exposureId),reason:'abandoned'});
  }
  expect(ml.fits).toHaveLength(fitCount);expect(await runtime!.calibrationExperiment!.snapshot(userId,experiment)).toEqual(snapshot);
  // Replace live listening cache before sealing: saved features and predictions
  // must keep the exact original snapshot throughout collection and Undo.
  const a1=new PostgresA1Store(db),cacheAt=new Date().toISOString();
  await a1.transaction(tx=>tx.putTasteContext({userId,source:'spotify-recently-played',completeHistory:false,fetchedAt:cacheAt,error:null,
   events:[{trackId:snapshot.draft.selected[40]!.trackId,playedAt:new Date(Date.parse(cacheAt)-60_000).toISOString()}]}));
  const seal=authoredSeal(snapshot),wrong=structuredClone(seal);wrong.evaluationCandidates[0]!.features.values.saved_age_days=123456;
  await expect(runtime!.calibrationExperiment!.seal(userId,wrong)).rejects.toMatchObject({code:'BATCH_SEAL_MISMATCH'});
  expect((await read())?.phase).toBe('reserved');
  const scoresBeforeSeal=ml.scores.length;
  const receipt=await runtime!.calibrationExperiment!.seal(userId,seal);
  expect(receipt.everFeedbackCount).toBe(0);expect(Date.parse(receipt.externalSealedAt)).toBeLessThanOrEqual(Date.parse(receipt.checkedAt));expect(Date.parse(receipt.checkedAt)).toBeLessThan(Date.parse(receipt.readyAt));
  expect(await runtime!.calibrationExperiment!.seal(userId,seal)).toEqual(receipt);
  await expect(runtime!.calibrationExperiment!.seal(userId,{...seal,artifacts:{...seal.artifacts,predictionsSha256:sha('different')}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  let ready=await readReady();expect(ready.entries).toHaveLength(60);expect(ready.queue.items).toHaveLength(60);
  const frozenFor=(trackId:string)=>snapshot.draft.candidates.find(c=>c.track.trackId===trackId)!;
  for(const item of ready.queue.items){
   const frozen=frozenFor(item.track.trackId),stored=(await repository.getExposure(userId,item.exposure.exposureId))!;
   expect(stored.features).toEqual(frozen.features);expect(stored.prediction).toEqual(frozen.prediction);expect(stored.listeningContext).toEqual(frozen.listeningContext);
  }
  expect(ml.scores).toHaveLength(scoresBeforeSeal);expect(ml.fits).toHaveLength(fitCount);
  const a=ready.entries[0]!,b=ready.entries[40]!,aLabel=await label(a,1);
  await awaitFit(aLabel.result.feedbackRevision,12);
  expect((await repository.trainingExamples(userId)).examples.some(e=>aIds.has(e.trackId))).toBe(false);
  const bLabel=await label(b,0);await awaitFit(bLabel.result.feedbackRevision,13);
  expect((await repository.trainingExamples(userId)).examples.find(e=>e.trackId===b.trackId)).toMatchObject({label:0,split:'train',features:frozenFor(b.trackId).features});
  expect((await post('/api/calibration/labels',bLabel.request)).status).toBe(200);
  expect(await runtime!.calibrationExperiment!.seal(userId,seal)).toEqual(receipt);
  const undoRequest={idempotencyKey:crypto.randomUUID()},undoPath=`/api/calibration/labels/${bLabel.result.labelId}/undo`;
  const undoneResponse=await post(undoPath,undoRequest);expect(undoneResponse.status).toBe(200);
  const undone=CalibrationLabelResultSchema.parse(await undoneResponse.json());expect(undone.state).toBe('revoked');await awaitFit(undone.feedbackRevision,12);
  expect((await post(undoPath,undoRequest)).status).toBe(200);
  ready=await readReady();const renewed=ready.entries.find(e=>e.batchItemId===b.batchItemId)!;expect(renewed.exposureId).not.toBe(b.exposureId);
  expect((await repository.getExposure(userId,renewed.exposureId))?.features).toEqual(frozenFor(b.trackId).features);
  const aUndo=await post(`/api/calibration/labels/${aLabel.result.labelId}/undo`,{idempotencyKey:crypto.randomUUID()});expect(aUndo.status).toBe(200);
  const aUndone=CalibrationLabelResultSchema.parse(await aUndo.json());await awaitFit(aUndone.feedbackRevision,12);
  ready=await readReady();const renewedA=ready.entries.find(e=>e.batchItemId===a.batchItemId)!;
  const beforeSkipFits=ml.fits.length,beforeSkipScores=ml.scores.length;
  const skipA=await post(`${experimentPath}/skip`,{exposureId:renewedA.exposureId,idempotencyKey:crypto.randomUUID()});expect(skipA.status).toBe(200);
  ready=CalibrationExperimentReadySchema.parse(await skipA.json());expect(ready.entries).toHaveLength(60);expect(ready.entries.filter(e=>e.group==='A')).toHaveLength(40);
  expect(ready.entries.find(e=>e.batchItemId===a.batchItemId)?.status).toBe('skipped');
  const skipRequest={exposureId:renewed.exposureId,idempotencyKey:crypto.randomUUID()};
  const skipB=await post(`${experimentPath}/skip`,skipRequest);expect(skipB.status).toBe(200);ready=CalibrationExperimentReadySchema.parse(await skipB.json());
  const replacement=ready.entries.find(e=>e.replacementFor===b.batchItemId)!;
  expect(replacement.trackId).toBe(snapshot.draft.replacementPool[20]!.trackId);expect(ready.entries).toHaveLength(61);
  expect(CalibrationExperimentReadySchema.parse(await(await post(`${experimentPath}/skip`,skipRequest)).json())).toEqual(ready);
  expect((await repository.getExposure(userId,replacement.exposureId))?.prediction).toEqual(frozenFor(replacement.trackId).prediction);
  expect(ml.fits).toHaveLength(beforeSkipFits);expect(ml.scores).toHaveLength(beforeSkipScores);
  expect((await policy.reviewCandidates(userId)).eligibleTrackIds.some(id=>aIds.has(id))).toBe(false);
  expect(ml.fits.every(request=>request.examples.every(e=>!aIds.has(e.trackId)))).toBe(true);
  const [rewards]=await db.transaction(tx=>tx`SELECT count(*)::integer AS n FROM policy_delivery_events WHERE user_id=${userId} AND kind='associate'`);expect(rewards.n).toBe(0);
  expect((await runtime!.calibrationExperiment!.snapshot(userId,experiment))!.draft).toEqual(snapshot.draft);
  expect(await ml.modelFiles(fitted.modelVersion)).toEqual(frozenModelFiles);expect(provider.writes).toEqual([]);
  // An application restart resumes the exact ready collection without rescoring.
  await runtime!.close();runtime=undefined;base=await start();expect(await readReady()).toEqual(ready);
  expect(runtime!.config.effectiveReviewSelectionPolicy).toBe('c1');expect(ml.fits).toHaveLength(beforeSkipFits);expect(ml.scores).toHaveLength(beforeSkipScores);
 }finally{try{await runtime?.close();}finally{try{await ml?.close();}finally{try{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);}finally{await db.close();}}}}
},240_000);

test.skipIf(!databaseUrl)('Batch3 runtime gates missing or partial 017 while preserving ordinary calibration',async()=>{
 const db=new Database(databaseUrl!,`test_experiment_runtime_${crypto.randomUUID().replaceAll('-','')}`);
 let runtime:Runtime|undefined;
 try{
  await migrate(db);
  const start=async()=>{runtime=await buildRuntime({env:environment(db),spotifyHttp:new SpotifyHttp({fetch:controlledSpotify().fetch})});return runtime.app.listen({host:'127.0.0.1',port:0});};
  let base=await start(),headers={cookie:await login(base)};
  expect(runtime!.startupIssues).toEqual([]);
  const response=await fetch(`${base}${experimentPath}`,{headers});
  expect(response.status).toBe(200);expect(CalibrationExperimentReadSchema.parse(await response.json())).toEqual({batch:null});
  for(const name of ['reserve','seal','snapshot','candidates'])expect((await fetch(`${base}${experimentPath}/${name}`,{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:'{}'})).status).toBe(404);
  await runtime!.close();runtime=undefined;
  // A missing migration marker must not expose even an otherwise present table.
  await db.transaction(tx=>tx`DELETE FROM schema_migrations WHERE name='017_calibration_batch3.sql'`);
  base=await start();headers={cookie:await login(base)};
  expect(runtime!.startupIssues).toContain('CALIBRATION_EXPERIMENT_DATABASE_UNAVAILABLE');
  expect((await fetch(`${base}${experimentPath}`,{headers})).status).toBe(503);
  expect((await fetch(`${base}/api/calibration/queue`,{headers})).status).toBe(200);
  await runtime!.close();runtime=undefined;
  await db.transaction(async tx=>{
   await tx`INSERT INTO schema_migrations(name,checksum) VALUES('017_calibration_batch3.sql','synthetic-runtime-readiness-only')`;
   await tx.unsafe(`DROP TRIGGER guard_experiment_labels ON "${db.schema}".calibration_labels`);
  });
  base=await start();headers={cookie:await login(base)};
  expect(runtime!.startupIssues).toContain('CALIBRATION_EXPERIMENT_DATABASE_UNAVAILABLE');
  expect((await fetch(`${base}${experimentPath}`,{headers})).status).toBe(503);
  expect((await fetch(`${base}/api/calibration/queue`,{headers})).status).toBe(200);
 }finally{try{await runtime?.close();}finally{try{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);}finally{await db.close();}}}
},60_000);

function environment(db:Database):Record<string,string|undefined>{return {
 NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:db.schema,
 SPOTIFY_CLIENT_ID:'controlled-batch3-client',SPOTIFY_ALLOWED_USER_IDS:owner,
 TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,17).toString('base64'),SESSION_SECRET:'controlled-batch3-test-only-'.repeat(3),
 METADATA_RIGHTS_BASIS:'Authored synthetic integration fixtures; no real research data',
};}

async function login(base:string){
 const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});expect(start.status).toBe(302);
 const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
 const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state,code:'controlled-code'})}`,{headers:{cookie:start.headers.get('set-cookie')!.split(';')[0]!},redirect:'manual'});
 expect(callback.status).toBe(302);
 return callback.headers.getSetCookie().find(value=>value.startsWith('sortfm_session='))!.split(';')[0]!;
}

function controlledSpotify(){
 const ids:string[]=[];for(let n=1;ids.length<108;n++){const id=String(n).padStart(22,'0');if(feedbackSplit(userId,id)==='train')ids.push(id);}
 const tracks=ids.map((id,index)=>({added_at:new Date(Date.UTC(2020,0,1+index)).toISOString(),track:{id,name:`Authored Batch3 song ${index}`,duration_ms:90_000+index*3000,is_playable:true,
  artists:[{id:`authored-artist-${index}`,name:`Authored artist ${index}`}],album:{name:'Authored album',release_date:'2019-01-01',images:[]}}}));
 const calls:string[]=[],writes:string[]=[];
 return {tracks,calls,writes,fetch:async(url:string,init?:RequestInit)=>{
 const parsed=new URL(url),method=init?.method??'GET';
 calls.push(`${method}:${parsed.pathname}`);
 if(parsed.pathname==='/api/token'&&method==='POST')return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-read-recently-played'});
 if(parsed.pathname==='/v1/me'&&method==='GET')return Response.json({id:owner,display_name:'Authored Batch3 account',images:[]});
 if(parsed.pathname==='/v1/me/player/recently-played'&&method==='GET')return Response.json({items:[{track:{id:ids[0]},played_at:new Date(Date.now()-60_000).toISOString()}]});
 if(parsed.pathname==='/v1/me/tracks'&&method==='GET'){
  const offset=Number(parsed.searchParams.get('offset')??0),limit=50,next=offset+limit<tracks.length?`https://api.spotify.com/v1/me/tracks?offset=${offset+limit}&limit=${limit}`:null;
  return Response.json({offset,limit,total:tracks.length,next,items:tracks.slice(offset,offset+limit)});
 }
 if(method!=='GET')writes.push(`${method}:${parsed.pathname}`);
 throw Error('Unexpected controlled Spotify request');
}};}

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const digest=(value:unknown)=>sha(calibrationExperimentCanonical(value));
function authoredSeal(snapshot:CalibrationExperimentSnapshot):CalibrationExperimentSealInput{
 const {draft,reservation}=snapshot,a=draft.selected.slice(0,40).map(s=>draft.candidates.find(c=>c.track.trackId===s.trackId)!);
 const evaluationCandidates=a.map(c=>({trackId:c.track.trackId,features:c.features})),queryGroups=Object.fromEntries(a.map(c=>[c.track.trackId,c.track.artists[0]?.id??null]));
 return {batchId:draft.batchId,idempotencyKey:createIdempotencyKey(),expected:reservation.digests,research:draft.research,externalSealedAt:new Date().toISOString(),evaluationCandidates,queryGroups,
  artifacts:{modelSealSha256:draft.research.modelSealSha256,candidatesSha256:digest(evaluationCandidates),queryGroupsSha256:digest(queryGroups),
   ownerManifestSha256:digest({owner:userId,batchId:draft.batchId}),panelReviewSha256:sha('authored panel review'),predictionsSha256:digest(a.map(c=>c.prediction)),queryAuditSha256:sha('authored query audit'),predictionSealSha256:sha('authored prediction seal')}};
}
async function eventually(name:string,check:()=>Promise<boolean>,timeoutMs=30_000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await Bun.sleep(100);}throw Error(`Timed out waiting for ${name}`);}

async function localMl(){
 const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-experiment-backend-ml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});const port=reservation.port!;await reservation.stop(true);
 const directUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const worker=Bun.spawn(['uv','run','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{
  env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir},stdout:'ignore',stderr:'ignore',
 });
 const fits:FitRequest[]=[],selects:PolicySelectRequest[]=[],scores:string[]=[];
 const proxy=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const url=new URL(request.url);
  if(url.pathname==='/fit')fits.push(FitRequestSchema.parse(await request.clone().json()));
  if(url.pathname==='/policy/select')selects.push(PolicySelectRequestSchema.parse(await request.clone().json()));
  if(url.pathname==='/score')scores.push(url.pathname);
  return fetch(new Request(`${directUrl}${url.pathname}${url.search}`,request));
 }});
 const close=async()=>{try{await proxy.stop(true);}finally{try{if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;}finally{await rm(artifactDir,{recursive:true,force:true});}}};
 try{
  await eventually('isolated Python readiness',async()=>{if(worker.exitCode!==null)throw Error('Isolated ML exited before readiness');return Boolean((await fetch(`${directUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);});
  return {serviceUrl:`http://127.0.0.1:${proxy.port}`,sharedSecret,client:createMlClient({serviceUrl:directUrl,sharedSecret}),fits,selects,scores,close,
   modelFiles:async(version:string)=>{
    const files=(await readdir(artifactDir,{recursive:true})).filter(path=>path.endsWith(`/${version}.json`)||path.endsWith(`/${version}.joblib`));
    return Object.fromEntries(await Promise.all(files.sort().map(async path=>[path,sha(new Uint8Array(await Bun.file(join(artifactDir,path)).arrayBuffer()))])));
   },
  };
 }catch(error){await close();throw error;}
}
