/** Guarded runtime + real local Python ML + disposable PostgreSQL; Spotify is fake. */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,migrate,PostgresA1Store,Repository,reviewExclusionManifestDigest} from '@sortfm/db';
import {QueueResultSchema,ReviewResultSchema,PolicyAssociationEventSchema,PolicyAssociationReceiptSchema,PolicySelectRequestSchema,PolicyDiagnosticsSchema,type QueueResult,type ReviewResult,type PolicyAssociationEvent,type PolicyAssociationReceipt,type PolicyFitReceipt,type PolicySelectRequest} from '@sortfm/contracts';
import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
import {buildRuntime} from '../src/runtime';
import {createMlClient,createPolicyClient,feedbackSplit} from '../src/ml';
const databaseUrl=process.env.TEST_DATABASE_URL;
const owner='pilot.realml.synthetic.owner',userId=`spotify:${owner}`,origin='http://127.0.0.1:5173';
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
type Item=QueueResult['items'][number];
type Association={payload:PolicyAssociationEvent;receipt:PolicyAssociationReceipt|null;claimed_fit_receipt:PolicyFitReceipt|null;completed_at:Date|null;disposition:string|null};

test.skipIf(!databaseUrl)('guarded pilot: actual C1 fits and policy associations survive Undo, restart, fallback and C1 rollback',async()=>{
 const db=new Database(databaseUrl!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`),repo=new Repository(db);
 let runtime:Runtime|undefined,ml:Awaited<ReturnType<typeof localMl>>|undefined;
 const spotifyCalls:string[]=[];
 try{
  await migrate(db);
  await repo.upsertUser({id:userId,spotifyId:owner,displayName:'Authored pilot acceptance fixture',avatarUrl:null});
  const ids:string[]=[];for(let n=1;ids.length<12;n++){const id=String(n).padStart(22,'0');if(feedbackSplit(userId,id)==='train')ids.push(id);}
  const tracks=ids.map((id,i)=>({...demoTracks[i%demoTracks.length]!,trackId:id,source:'spotify' as const,spotifyUri:`spotify:track:${id}` as const,isPlayable:true}));
  await repo.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:ids,sourceTotal:ids.length,observedAt:new Date().toISOString()}));
  const inherited=createDemoQueue().items[0]!,inheritedTrack=tracks.at(-1)!;
  await repo.insertExposure({userId,exposure:{...inherited.exposure,trackId:inheritedTrack.trackId},prediction:inherited.prediction,features:{featureVersion:'sortfm.features.v1',values:{},provenance:'synthetic',permittedForTraining:false}});
  const payload={ownerId:userId,pilotSchema:db.schema,sortedTrackIds:[ids[0]!]};
  const manifest={...payload,sha256:reviewExclusionManifestDigest(payload)};
  ml=await localMl();
  const env={NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:db.schema,DEMO_MODE_ENABLED:'false',PUBLIC_WEB_ORIGIN:origin,
   PUBLIC_API_ORIGIN:'http://127.0.0.1:3001',ML_SERVICE_URL:ml.serviceUrl,ML_SERVICE_SHARED_SECRET:ml.sharedSecret,
   SPOTIFY_CLIENT_ID:'authored-client',SPOTIFY_ALLOWED_USER_IDS:owner,TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),SESSION_SECRET:'authored-pilot-acceptance-session-'.repeat(3),
   METADATA_RIGHTS_BASIS:'Authored synthetic fixtures; no real library or model efficacy claim',C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:'epsilon_greedy'};
  const startRuntime=async(rollback=false)=>{
   runtime=await buildRuntime({env:{...env,...(rollback?{C2_POLICY_ENABLED:'false'}:{})},pilot:{manifest,approvedManifestSha256:manifest.sha256,oauthFetch:async(url,init)=>{
    spotifyCalls.push(url);expect(init?.redirect).toBe('error');
    if(url==='https://accounts.spotify.com/api/token')return Response.json({access_token:'authored-access',refresh_token:'authored-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private'});
    if(url==='https://api.spotify.com/v1/me')return Response.json({id:owner,display_name:'Authored pilot acceptance fixture',images:[]});
    throw Error('Unexpected Spotify transport call');
   }}});
   expect(runtime.startupIssues).toEqual([]);return runtime.app.listen({host:'127.0.0.1',port:0});
  };
  let base=await startRuntime();
  const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});expect(start.status).toBe(302);
  const authorization=new URL(start.headers.get('location')!);expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
  const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state:authorization.searchParams.get('state')!,code:'authored-code'})}`,{redirect:'manual',headers:{cookie:start.headers.getSetCookie()[0]!.split(';')[0]!}});
  expect(callback.status).toBe(302);
  const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('sortfm_session='))!.split(';')[0]!,headers={cookie,origin,'content-type':'application/json'};
  const session=await(await fetch(`${base}/api/me`,{headers})).json() as {capabilities:unknown};expect(session.capabilities).toEqual({spotifyRead:true,spotifyWrite:false,playback:false});
  for(const path of ['/api/library/sync','/api/ml/retrain','/api/player/token','/api/calibration/labels'])expect((await fetch(`${base}${path}`,{method:'POST',headers,body:'{}'})).status).toBe(403);
  const initialFit=await runtime!.pilot!.ml.fit(userId); // Private operator bootstrap, actual C1 code.
  expect(initialFit.feedbackRevision).toBe(0);expect(initialFit.metrics.labeledExamples).toBe(0);
  expect(initialFit).toMatchObject({modelVersion:(await ml.client.evaluation({userId})).modelVersion});
  const queue=async()=>{
   const response=await fetch(`${base}/api/queue?limit=1`,{headers});expect(response.status).toBe(200);
   const q=QueueResultSchema.parse(await response.json());expect(q.items).toHaveLength(1);expect(q.items[0]!.track.trackId).not.toBe(ids[0]);
   const item=q.items[0]!,stored=await runtime!.pilot!.repository.getExposure(userId,item.exposure.exposureId);
   expect(stored?.prediction).toEqual(item.prediction);
   expect((await ml!.client.explain({userId,exposureId:item.exposure.exposureId})).prediction).toEqual(item.prediction);
   return q;
  };
  const awaitDecision=async(id:string,status:'COMPLETE'|'UNDONE')=>{
   let result:ReviewResult|null=null;await eventually('committed pilot decision',async()=>{result=await runtime!.pilot!.repository.getDecision(userId,id);return result?.status===status;});return result!;
  };
  const act=async(item:Item,action:'KEEP'|'SKIP')=>{
   const body=JSON.stringify({trackId:item.track.trackId,exposureId:item.exposure.exposureId,action,idempotencyKey:crypto.randomUUID()});
   const response=await fetch(`${base}/api/decisions`,{method:'POST',headers,body});expect(response.status).toBe(202);
   const pending=ReviewResultSchema.parse(await response.json());return {body,result:await awaitDecision(pending.decisionId,'COMPLETE')};
  };
  const awaitFit=async(revision:number,labels:number)=>{
   await eventually('actual C1 fit receipt',async()=>{const [job]=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);return Number(job?.acknowledged_revision)===revision;});
   const metrics=await ml!.client.evaluation({userId});expect(metrics.labeledExamples).toBe(labels);
   const [receipt]=await db.transaction(tx=>tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`);
   expect(receipt).toMatchObject({model_version:metrics.modelVersion,feedback_revision:revision});return metrics;
  };
  const associations=():Promise<Association[]>=>db.transaction(tx=>tx`SELECT payload,receipt,claimed_fit_receipt,completed_at,disposition FROM policy_delivery_events WHERE user_id=${userId} AND kind='associate' ORDER BY sequence`);
  const awaitAssociations=async(count:number,rewards:number)=>{
   await eventually('actual policy association acknowledgement',async()=>{const rows=await associations();return rows.length===count&&rows.every(r=>r.completed_at!==null);});
   const rows=await associations();
   for(const row of rows){const event=PolicyAssociationEventSchema.parse(row.payload),receipt=PolicyAssociationReceiptSchema.parse(row.receipt);
    expect(row.disposition).toBe('acknowledged');expect(receipt.eventId).toBe(event.eventId);expect(receipt.sequence).toBe(event.sequence);expect(receipt.fitReceipt).toEqual(row.claimed_fit_receipt!);expect(receipt.fitReceipt.synchronizedFeedbackRevision).toBeGreaterThanOrEqual(event.feedbackRevision);}
   const diagnostics=await ml!.diagnostics();expect(diagnostics.counts.activeRewards).toBe(rewards);expect(diagnostics.counts.feedbackEvents).toBe(count);return rows;
  };
  const first=(await queue()).items[0]!,frozen=await runtime!.pilot!.repository.getExposure(userId,first.exposure.exposureId);
  expect(first.exposure.policyTelemetry?.selectionMethod).toBe('c1'); // Actual cold policy behavior.
  const keep=await act(first,'KEEP');expect(keep.result.label).toBe(0);
  const keepFit=await awaitFit(keep.result.feedbackRevision,1),kept=await awaitAssociations(1,1);
  expect(kept[0]!.receipt!.eligibleForLearning).toBe(true);expect(kept[0]!.claimed_fit_receipt!.modelVersion).toBe(keepFit.modelVersion);
  expect(kept[0]!.payload).toMatchObject({operation:'upsert',label:0,exposureId:first.exposure.exposureId,decisionId:keep.result.decisionId});
  const replay=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:keep.body});expect(replay.status).toBe(200);expect((await replay.json() as ReviewResult).decisionId).toBe(keep.result.decisionId);
  const second=(await queue()).items[0]!;expect(second.track.trackId).not.toBe(first.track.trackId);expect(second.exposure.policyTelemetry?.selectionMethod).toBe('epsilon_greedy');
  const skip=await act(second,'SKIP');expect(skip.result.label).toBeNull();expect(skip.result.feedbackRevision).toBe(keep.result.feedbackRevision);
  const skipped=await awaitAssociations(2,1);expect(skipped[1]!.receipt!.eligibleForLearning).toBe(false);expect(skipped[1]!.payload).toMatchObject({operation:'upsert',label:null,decisionId:skip.result.decisionId});
  expect((await ml.policy.exposure({userId,exposureId:second.exposure.exposureId})).reservation.closureReason).toBe('skip');
  const undoBody=JSON.stringify({idempotencyKey:crypto.randomUUID()}),undoPath=`/api/decisions/${keep.result.decisionId}/undo`;
  expect((await fetch(`${base}${undoPath}`,{method:'POST',headers,body:undoBody})).status).toBe(409);
  const undone=await awaitDecision(keep.result.decisionId,'UNDONE');await awaitFit(undone.feedbackRevision,0);
  const revoked=await awaitAssociations(3,0);expect(revoked[2]!.payload).toMatchObject({operation:'revoke',label:null,exposureId:first.exposure.exposureId});expect(revoked[2]!.receipt!.eligibleForLearning).toBe(false);
  expect((await fetch(`${base}${undoPath}`,{method:'POST',headers,body:undoBody})).status).toBe(200);
  expect(await runtime!.pilot!.repository.getExposure(userId,first.exposure.exposureId)).toEqual(frozen);

  // Restart both real processes with the same manifest, artifacts and durable session.
  const beforeRestart=await queue(),active=beforeRestart.items[0]!,inspection=await ml.policy.exposure({userId,exposureId:active.exposure.exposureId});
  const selects=ml.selects.length;await runtime!.close();runtime=undefined;await ml.restart();base=await startRuntime();
  expect((await queue()).items).toEqual(beforeRestart.items);expect(ml.selects).toHaveLength(selects);
  const restored=await ml.policy.exposure({userId,exposureId:active.exposure.exposureId});expect(restored.decision).toEqual(inspection.decision);expect(restored.reservation.expiresAt).toBe(inspection.reservation.expiresAt);
  await act(active,'SKIP');await awaitAssociations(4,0);

  // Controlled failure only at select: score/fit/explain still execute real C1.
  ml.failSelection();const fallback=await queue(),fallbackItem=fallback.items[0]!;
  expect(fallbackItem.exposure.policyVersion).toBe('queue:c1-fallback:epsilon_greedy:v1');expect(fallbackItem.exposure.policyTelemetry).toBeUndefined();expect(fallback.fallbackReason).toContain('using C1');
  expect(ml.failures).toHaveLength(1);expect(fallbackItem.exposure.exposureId).not.toBe(ml.failures[0]);
  const [failed]=await db.transaction(tx=>tx`SELECT published,closure_reason,closed_at FROM policy_exposure_bindings WHERE exposure_id=${ml!.failures[0]!}`);expect(failed.published).toBe(false);expect(failed.closure_reason).toBe('abandoned');expect(failed.closed_at).not.toBeNull();
  expect((await queue()).items).toEqual(fallback.items);
  const fallbackSkip=await act(fallbackItem,'SKIP');expect(fallbackSkip.result.label).toBeNull();expect(await associations()).toHaveLength(4);

  // Explicit C1 rollback must keep the pilot publication fence and exclusion set.
  await runtime!.close();runtime=undefined;const beforeRollback=ml.selects.length;base=await startRuntime(true);
  const rollback=(await queue()).items[0]!;expect(rollback.exposure.policyTelemetry).toBeUndefined();expect(ml.selects).toHaveLength(beforeRollback);
  const rollbackStored=await runtime!.pilot!.repository.getExposure(userId,rollback.exposure.exposureId);expect(rollbackStored).not.toBeNull();
  expect((await runtime!.pilot!.policyStore.currentSelection(userId))?.publication?.items).toContainEqual(rollbackStored!);
  expect((await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify({trackId:inheritedTrack.trackId,exposureId:inherited.exposure.exposureId,action:'KEEP',idempotencyKey:crypto.randomUUID()})})).status).toBe(403);
  await act(rollback,'SKIP');expect(await associations()).toHaveLength(4);
  expect(ml.selects.every(r=>r.candidates.every(c=>c.trackId!==ids[0]))).toBe(true);
  expect(spotifyCalls).toEqual(['https://accounts.spotify.com/api/token','https://api.spotify.com/v1/me']);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM import_jobs`)).toHaveLength(0);
  expect((await repo.library(userId)).map(row=>row.track.trackId).sort()).toEqual([...ids].sort());
 }finally{
  const failures:unknown[]=[];for(const cleanup of [()=>runtime?.close(),()=>ml?.close(),()=>db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`),()=>db.close()])try{await cleanup();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Disposable pilot acceptance cleanup failed');
 }
},180000);

async function eventually(label:string,check:()=>Promise<boolean>,timeoutMs=25000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await Bun.sleep(100);}throw Error(`Timed out: ${label}`);}
async function localMl(){
 const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-pilot-realml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}),port=reservation.port!;await reservation.stop(true);
 const directUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const spawn=()=>Bun.spawn(['uv','run','--offline','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir},stdout:'ignore',stderr:'ignore'});
 let worker=spawn(),fail=false;const selects:PolicySelectRequest[]=[],failures:string[]=[];
 const proxy=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const url=new URL(request.url);if(url.pathname==='/policy/select'){const r=PolicySelectRequestSchema.parse(await request.clone().json());selects.push(r);if(fail){failures.push(r.exposureId);return Response.json({code:'POLICY_STATE_UNAVAILABLE',message:'Authored select outage',retryable:true},{status:503});}}
  return fetch(new Request(`${directUrl}${url.pathname}${url.search}`,request));
 }});
 const ready=()=>eventually('local Python readiness',async()=>{if(worker.exitCode!==null)throw Error('Local Python exited before readiness (offline uv cache required)');return Boolean((await fetch(`${directUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);},60000);
 const stopWorker=async()=>{if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;};
 const close=async()=>{try{await proxy.stop(true);}finally{try{await stopWorker();}finally{await rm(artifactDir,{recursive:true,force:true});}}};
 try{await ready();return {serviceUrl:`http://127.0.0.1:${proxy.port}`,sharedSecret,selects,failures,close,diagnostics:async()=>PolicyDiagnosticsSchema.parse(await(await fetch(`${directUrl}/policy/diagnostics?${new URLSearchParams({userId})}`,{headers:{authorization:`Bearer ${sharedSecret}`}})).json()),failSelection:()=>{fail=true;},restart:async()=>{await stopWorker();worker=spawn();await ready();},client:createMlClient({serviceUrl:directUrl,sharedSecret}),policy:createPolicyClient({serviceUrl:directUrl,sharedSecret})};}
 catch(error){await close();throw error;}
}
