import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,migrate,Repository} from '@sortfm/db';
import {ReviewRequestSchema,type FitResponse,type ReviewResult,type TrackCard} from '@sortfm/contracts';
import {createMlClient,createRepositoryMl,assembleLibraryCandidates,feedbackSplit} from '../ml';
import {QueueService} from './queue';
import {FeedbackWorker} from './feedback';

test.skipIf(!process.env.TEST_DATABASE_URL || process.env.ML_ADAPTER_INTEGRATION!=='1')('Tiger settlement outbox delivers full snapshots to real C1 across worker reconstruction and Undo',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sortfm-feedback-'));
  const reservation=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('reserved')});
  const port=reservation.port;await reservation.stop(true);
  const url=`http://127.0.0.1:${port}`,secret=crypto.randomUUID();
  const db=new Database(process.env.TEST_DATABASE_URL!,`test_a2_feedback_${crypto.randomUUID().replaceAll('-','')}`);
  const serviceRoot=fileURLToPath(new URL('../../../../services/ml',import.meta.url));
  const processMl=Bun.spawn(['uv','run','--directory',serviceRoot,'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...process.env,ML_SERVICE_SHARED_SECRET:secret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe'});
  try {
    let ready=false;for(let i=0;i<600;i++){try{ready=(await fetch(`${url}/health`)).ok;}catch{}if(ready)break;await Bun.sleep(50);}expect(ready).toBe(true);
    await migrate(db);const repository=new Repository(db),userId='spotify:feedback-test';
    await repository.upsertUser({id:userId,spotifyId:'feedback-test',displayName:'Synthetic test account',avatarUrl:null},true);
    const track:TrackCard={trackId:'0000000000000000000001',source:'spotify',spotifyUri:'spotify:track:0000000000000000000001',title:'Synthetic integration track',artists:[{id:null,name:'Test'}],album:'',imageUrl:null,durationMs:1000,explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true};
    await repository.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved'}]);
    const client=createMlClient({serviceUrl:url,sharedSecret:secret}),ml=createRepositoryMl({repository,client});
    const queue=new QueueService(repository,{assemble:(rows,ctx)=>assembleLibraryCandidates(rows,{...ctx,now:new Date(ctx.now).toISOString(),metadataTraining:{permittedForTraining:true,rightsBasis:'Original synthetic integration fixtures'}}),score:ml.score});
    const item=(await queue.get(userId,{limit:1,policy:'balanced',mode:'spotify'})).items[0]!;
    const request=ReviewRequestSchema.parse({trackId:track.trackId,action:'KEEP',exposureId:item.exposure.exposureId,idempotencyKey:crypto.randomUUID()});
    const pending=await repository.createDecision({userId,decisionId:crypto.randomUUID(),request,requestFingerprint:'fixture-keep',createdAt:new Date().toISOString()});
    const completed:ReviewResult={...pending,status:'COMPLETE',mutationStep:'NONE',label:0,labelState:'active',feedbackRevision:1,canUndo:true,updatedAt:new Date().toISOString()};
    await repository.settleDecision(userId,completed,'PENDING',feedbackSplit(userId,track.trackId));
    const fitted:FitResponse[]=[];
    // Reconstruct repository and worker AFTER commit: no in-memory event delivery.
    const worker=new FeedbackWorker(new Repository(db),{fit:async id=>{const response=await ml.fit(id);fitted.push(response);return response;}});
    expect(await worker.runOnce()).toBe(true);expect(fitted[0]!.feedbackRevision).toBe(1);expect(fitted[0]!.metrics.labeledExamples).toBe(1);
    expect(await worker.runOnce()).toBe(false);
    await repository.createUndo({userId,commandId:crypto.randomUUID(),decisionId:pending.decisionId,request:{idempotencyKey:crypto.randomUUID() as typeof request.idempotencyKey},requestFingerprint:'fixture-undo',createdAt:new Date().toISOString()});
    await repository.settleDecision(userId,{...completed,status:'UNDONE',label:null,labelState:'revoked',feedbackRevision:2,canUndo:false,updatedAt:new Date().toISOString()},'COMPLETE',feedbackSplit(userId,track.trackId));
    const restarted=new FeedbackWorker(new Repository(db),{fit:async id=>{const response=await ml.fit(id);fitted.push(response);return response;}});
    expect(await restarted.runOnce()).toBe(true);expect(fitted[1]!.feedbackRevision).toBe(2);expect(fitted[1]!.metrics.labeledExamples).toBe(0);
    expect(await restarted.runOnce()).toBe(false);
    expect((await repository.getExposure(userId,item.exposure.exposureId))!.prediction).toEqual(item.prediction);
  } finally {
    processMl.kill('SIGTERM');await processMl.exited;
    await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();await rm(directory,{recursive:true,force:true});
  }
},90000);
