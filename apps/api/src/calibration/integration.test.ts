/** Opt-in disposable Tiger + real C1 acceptance; exclusively generated fixture data. */
import {expect,test} from 'bun:test';
import Fastify from 'fastify';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,Repository,PostgresA1Store,migrate} from '@sortfm/db';
import {CalibrationQueueResultSchema,CalibrationLabelResultSchema,FitResponseSchema,type CalibrationLabelRequest,type CalibrationLabelResult} from '@sortfm/contracts';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import {CalibrationQueue} from './queue';
import {CalibrationService} from './service';
import {createCalibrationModule} from './module';
import {row} from './test-fixtures';
import {assembleLibraryCandidates} from '../ml/features';
import {createMlClient} from '../ml/client';
import {createRepositoryMl} from '../ml/repository';
import {createMlRetrainModule} from '../ml/retrain';
import {FeedbackWorker} from '../reviews/feedback';

const owner='spotify:calibration-integration';
test.skipIf(process.env.CALIBRATION_INTEGRATION!=='1'||!process.env.TEST_DATABASE_URL)(
 'real persistence and C1: preference labels, replay, Undo, outbox and manual retrain never mutate Spotify',async()=>{
  // Resolve only when explicitly enabled: baseline unit tests do not need D's optional adapter.
  const {PostgresCalibrationStore}=await import('@sortfm/db');
  const db=new Database(process.env.TEST_DATABASE_URL!,`test_calibration_api_${crypto.randomUUID().replaceAll('-','')}`);
  const directory=await mkdtemp(join(tmpdir(),'sortfm-calibration-'));
  const reservation=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('reserved')});
  const port=reservation.port;await reservation.stop(true);
  const url=`http://127.0.0.1:${port}`,secret=crypto.randomUUID();
  const worker=Bun.spawn(['uv','run','--directory',fileURLToPath(new URL('../../../../services/ml',import.meta.url)),
   'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],
   {env:{...process.env,ML_SERVICE_SHARED_SECRET:secret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe'});
  const app=Fastify(),nativeFetch=globalThis.fetch;let rejectedExternalCalls=0;
  globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
   const target=new URL(input instanceof Request?input.url:String(input));
   if(target.origin!==url){rejectedExternalCalls++;throw Error('External network forbidden in calibration acceptance');}
   return nativeFetch(input,init);
  }) as typeof fetch;
  try{
   await migrate(db);
   let ready=false;
   for(let i=0;i<600;i++){try{ready=(await fetch(`${url}/health`)).ok;}catch{}if(ready)break;await Bun.sleep(50);}
   expect(ready).toBe(true);
   const repository=new Repository(db),store=new PostgresCalibrationStore(db),a1=new PostgresA1Store(db);
   const rows=Array.from({length:80},(_,i)=>{const value=row(i+1);value.track.durationMs=60000+(i+1)*3000;return value;});
   const seededAt=new Date().toISOString();
   await repository.upsertUser({id:owner,spotifyId:null,displayName:'Generated fixture',avatarUrl:null});
   await repository.upsertSavedTracks(rows.map(({track})=>({userId:owner,track,originalAddedAt:track.originalAddedAt,syncedAt:seededAt,currentStatus:'saved'})));
   await a1.transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,
    trackIds:rows.map(r=>r.track.trackId),sourceTotal:rows.length,observedAt:seededAt}));
   const before=await repository.library(owner);
   const ml=createRepositoryMl({repository,client:createMlClient({serviceUrl:url,sharedSecret:secret})});
   const queue=new CalibrationQueue(store,{score:ml.score,scoreTimeoutMs:10000,assemble:(library,context)=>
    assembleLibraryCandidates(library,{userId:context.userId,now:new Date(context.now).toISOString(),
     metadataTraining:{permittedForTraining:true,rightsBasis:'Original generated integration fixtures'}})
      .map(candidate=>({...candidate,features:{...candidate.features,provenance:'synthetic' as const}}))});
   let kicks=0;
   const service=new CalibrationService(store,{feedback:{kick(){kicks++;}}});
   const security={config:{secureCookies:false,webOrigin:'http://localhost:5173',apiOrigin:'http://localhost:3001'},
    auth:{session:async(token?:string)=>token==='fixture-session'?{user:{id:owner}}:null}};
   await app.register(createCalibrationModule({...security,service,queue}).registerRoutes);
   await app.register(createMlRetrainModule({...security,ml}).registerRoutes);
   const headers={cookie:'sortfm_session=fixture-session',origin:security.config.webOrigin};
   const pageResponse=await app.inject({url:'/api/calibration/queue?limit=40',headers});
   expect(pageResponse.statusCode).toBe(200);
   const page=CalibrationQueueResultSchema.parse(pageResponse.json());
   expect(page.items).toHaveLength(40);expect(page.fallbackReason).toBeNull();
   const requests:CalibrationLabelRequest[]=[],labels:CalibrationLabelResult[]=[];
   for(const item of page.items){
    const payload:CalibrationLabelRequest={trackId:item.track.trackId,exposureId:item.exposure.exposureId,
     label:item.track.durationMs>=180000?1:0,idempotencyKey:createIdempotencyKey()};requests.push(payload);
    const response=await app.inject({method:'POST',url:'/api/calibration/labels',headers,payload});
    expect(response.statusCode).toBe(200);labels.push(CalibrationLabelResultSchema.parse(response.json()));
   }
   const snapshot=await repository.trainingExamples(owner);
   expect(snapshot.feedbackRevision).toBe(40);expect(snapshot.examples).toHaveLength(40);
   expect(new Set(snapshot.examples.map(e=>e.trackId)).size).toBe(40);
   for(const example of snapshot.examples){
    const exposure=await repository.getExposure(owner,labels.find(l=>l.trackId===example.trackId)!.exposureId);
    expect(example.features).toEqual(exposure!.features);
   }
   const train=snapshot.examples.filter(e=>e.split==='train');
   expect(train.filter(e=>e.label===0).length).toBeGreaterThanOrEqual(3);
   expect(train.filter(e=>e.label===1).length).toBeGreaterThanOrEqual(3);
   const replay=await app.inject({method:'POST',url:'/api/calibration/labels',headers,payload:requests[0]!});
   expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(labels[0]!);
   const history=await service.history(owner);expect(history.items).toHaveLength(40);
   const originalExplain=await ml.explain(owner,page.items[0]!.exposure.exposureId);
   const errors:string[]=[],feedback=new FeedbackWorker(repository,ml,{onError:code=>errors.push(code)});
   expect(await feedback.runOnce()).toBe(true);expect(errors).toEqual([]);
   const automatic=await ml.evaluation(owner);expect(automatic.labeledExamples).toBe(40);
   expect(automatic.trainedExamples).toBe(train.length);
   const fitResponse=await app.inject({method:'POST',url:'/api/ml/retrain',headers,payload:{}});
   expect(fitResponse.statusCode).toBe(200);
   const manual=FitResponseSchema.parse(fitResponse.json());expect(manual.modelVersion).toBe(automatic.modelVersion);
   expect(manual.feedbackRevision).toBe(40);
   const learned=await queue.get(owner,{limit:10});
   expect(learned.remaining).toBe(40);expect(learned.items.every(i=>i.prediction.modelKind==='logistic')).toBe(true);
   // Wrong-purpose requests fail inside D, before any cleanup command can exist.
   await expect(repository.createDecision({userId:owner,decisionId:crypto.randomUUID(),request:{
    trackId:learned.items[0]!.track.trackId,exposureId:learned.items[0]!.exposure.exposureId,action:'KEEP',idempotencyKey:createIdempotencyKey()},
    requestFingerprint:'fixture-purpose-check',createdAt:new Date().toISOString()})).rejects.toMatchObject({code:'EXPOSURE_PURPOSE_MISMATCH'});
   const reviewExposure=structuredClone((await repository.getExposure(owner,learned.items[0]!.exposure.exposureId))!);
   reviewExposure.exposure.exposureId=crypto.randomUUID();reviewExposure.exposure.servedAt=new Date().toISOString();
   await repository.insertExposure(reviewExposure);
   await expect(service.label(owner,{trackId:reviewExposure.exposure.trackId,exposureId:reviewExposure.exposure.exposureId,
    label:0,idempotencyKey:createIdempotencyKey()})).rejects.toMatchObject({code:'EXPOSURE_PURPOSE_MISMATCH'});
   const undo=await app.inject({method:'POST',url:`/api/calibration/labels/${labels[0]!.labelId}/undo`,headers,payload:{idempotencyKey:createIdempotencyKey()}});
   expect(undo.statusCode).toBe(200);expect(undo.json()).toMatchObject({state:'revoked',label:null,feedbackRevision:41});
   expect((await service.label(owner,requests[0]!)).state).toBe('revoked');
   const afterUndo=await repository.trainingExamples(owner);expect(afterUndo.examples).toHaveLength(39);
   for(const example of afterUndo.examples)expect(example.split).toBe(snapshot.examples.find(e=>e.trackId===example.trackId)!.split);
   expect(await feedback.runOnce()).toBe(true);expect(errors).toEqual([]);
   expect((await ml.evaluation(owner)).labeledExamples).toBe(39);
   expect(await ml.explain(owner,page.items[0]!.exposure.exposureId)).toEqual(originalExplain);
   const fresh=(await queue.get(owner,{limit:100})).items.find(i=>i.track.trackId===labels[0]!.trackId)!;
   expect(fresh).toBeDefined();
   const relabeled=await service.label(owner,{trackId:fresh.track.trackId,exposureId:fresh.exposure.exposureId,
    label:requests[0]!.label,idempotencyKey:createIdempotencyKey()});
   expect(relabeled.feedbackRevision).toBe(42);
   const afterRelabel=await repository.trainingExamples(owner);
   expect(afterRelabel.examples).toHaveLength(40);
   expect(afterRelabel.examples.find(e=>e.trackId===fresh.track.trackId)!.split).toBe(snapshot.examples.find(e=>e.trackId===fresh.track.trackId)!.split);
   expect(await feedback.runOnce()).toBe(true);expect(errors).toEqual([]);
   expect((await ml.evaluation(owner)).labeledExamples).toBe(40);
   expect(await ml.explain(owner,page.items[0]!.exposure.exposureId)).toEqual(originalExplain);
   const [audit]=await db.transaction(tx=>tx`SELECT (SELECT count(*)::int FROM review_decisions) AS decisions,
    (SELECT count(*)::int FROM review_work) AS work,(SELECT count(*)::int FROM spotify_mutations) AS mutations,
    (SELECT count(*)::int FROM library_membership WHERE user_id=${owner}) AS membership,
    (SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${owner}) AS acknowledged`);
   expect(audit).toEqual({decisions:0,work:0,mutations:0,membership:80,acknowledged:42});
   expect(await repository.library(owner)).toEqual(before);expect(rejectedExternalCalls).toBe(0);expect(kicks).toBe(44);
   console.info('Calibration Tiger/C1 acceptance:',JSON.stringify({labels:40,train:train.length,holdout:40-train.length,revision:42,spotifyCalls:0}));
  }finally{
   globalThis.fetch=nativeFetch;await app.close();worker.kill('SIGTERM');await worker.exited;
   try{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);}finally{await db.close();await rm(directory,{recursive:true,force:true});}
  }
 },180000);
