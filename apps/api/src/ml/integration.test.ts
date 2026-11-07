/** Opt-in real Bun -> FastAPI transport verification. No DB/provider/private data. */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FEATURE_VERSION,type FitRequest} from '@sortfm/contracts';
import {demoTracks} from '@sortfm/contracts/fixtures';
import {createMlClient} from './client';
import {assembleLibraryCandidates,type MlLibraryRow} from './features';
import {createRepositoryMl} from './repository';
import {createMlReadModule} from './reads';
import {buildApp} from '../app';
import {loadConfig} from '../config';

test.skipIf(process.env.ML_ADAPTER_INTEGRATION!=='1')('Bun adapter to real C1: metadata cold start, fit, score, immutable explain, revoke',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'sortfm-ts-ml-'));
 const reservation=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('reserved')});
 const port=reservation.port;await reservation.stop(true);
 const url=`http://127.0.0.1:${port}`,secret=crypto.randomUUID();
 const serviceRoot=fileURLToPath(new URL('../../../../services/ml',import.meta.url));
 const worker=Bun.spawn(['uv','run','--directory',serviceRoot,'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],
  {env:{...process.env,ML_SERVICE_SHARED_SECRET:secret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe'});
 try{
  let ready=false;
  for(let i=0;i<200;i++){
   try{ready=(await fetch(`${url}/health`)).ok;}catch{}
   if(ready)break;await Bun.sleep(50);
  }
  expect(ready).toBe(true);
  const client=createMlClient({serviceUrl:url,sharedSecret:secret});
  const rows:MlLibraryRow[]=Array.from({length:60},(_,i)=>({track:{...demoTracks[0]!,trackId:`demo:live-${i}`,durationMs:120000+i*1000},
   currentStatus:'saved',audioFeatures:null,currentDecision:null}));
  const candidates=assembleLibraryCandidates(rows,{userId:'demo:adapter',now:'2026-11-07T12:00:00Z',metadataTraining:{permittedForTraining:true,rightsBasis:'Original synthetic test rows'}})
   .map(candidate=>({...candidate,exposureId:crypto.randomUUID()}));
  const examples:FitRequest['examples']=candidates.map((candidate,i)=>({trackId:candidate.trackId,features:candidate.features,
   label:i%2 as 0|1,decisionId:crypto.randomUUID(),split:i<36?'train':'holdout',labeledAt:'2026-11-07T12:00:00Z'}));
  const adapter=createRepositoryMl({client,repository:{trainingExamples:async()=>({feedbackRevision:1,examples})}});
  const cold=await adapter.score('demo:adapter',candidates);
  expect(cold.predictions.every(row=>row.prediction.modelKind==='heuristic'&&row.prediction.removalProbability===null)).toBe(true);
  const fitted=await adapter.fit('demo:adapter');
  expect(fitted.trainedExamples).toBe(36);expect(fitted.metrics.status).toBe('available');
  // Replayed exposure retains the cold prediction despite the new current model.
  expect(await adapter.score('demo:adapter',candidates)).toEqual(cold);
  expect((await adapter.explain('demo:adapter',candidates[0]!.exposureId)).prediction).toEqual(cold.predictions[0]!.prediction);
  const fresh=candidates.map(candidate=>({...candidate,exposureId:crypto.randomUUID()}));
  const scored=await adapter.score('demo:adapter',fresh);
  expect(scored.modelVersion).toBe(fitted.modelVersion);
  expect(scored.predictions.every(row=>row.prediction.removalProbability!==null)).toBe(true);
  expect((await adapter.evaluation('demo:adapter',fitted.modelVersion)).heldOutExamples).toBe(24);
  const event={userId:'demo:adapter',eventId:crypto.randomUUID(),decisionId:examples[0]!.decisionId,
   exposureId:fresh[0]!.exposureId,trackId:fresh[0]!.trackId,feedbackRevision:2,
   operation:'revoke' as const,label:null,features:fresh[0]!.features,occurredAt:'2026-11-07T13:00:00Z'};
  const observed=await adapter.observe(event);expect(observed.accepted).toBe(true);
  expect(await adapter.observe(event)).toEqual(observed);
  expect((await adapter.evaluation('demo:adapter')).trainedExamples).toBe(35);
  const config=loadConfig({NODE_ENV:'test'});
  const summary={total:60,reviewed:59,remaining:1,kept:29,unliked:30,archived:0,skipped:0};
  const reads=createMlReadModule({config:{...config,secureCookies:false},ml:adapter,
   auth:{session:async token=>token==='synthetic-session'?{user:{id:'demo:adapter'}}:null},
   getSummary:async()=>summary,
   audioProgress:async()=>({provider:'soundnet',status:'disabled',featuresReady:0,featuresTotal:60,failed:0,
    missingness:{energy:1},reason:'No audio in this synthetic integration fixture.'}),
  });
  const api=await buildApp({config,registerRoutes:reads.registerRoutes});
  try{
   const insights=await api.inject({url:'/api/ml/insights',cookies:{sortfm_session:'synthetic-session'}});
   expect(insights.statusCode).toBe(200);
   expect(insights.json()).toMatchObject({prediction:null,metrics:{trainedExamples:35,labeledExamples:59},audioFeatures:{featuresTotal:60}});
   const analytics=await api.inject({url:'/api/analytics/summary',cookies:{sortfm_session:'synthetic-session'}});
   expect(analytics.statusCode).toBe(200);
   expect(analytics.json().library).toEqual(summary);
   expect(analytics.json().metrics).toEqual(insights.json().metrics);
  }finally{await api.close();}
  await expect(client.score({userId:'demo:other',featureVersion:FEATURE_VERSION,candidates:[],modelVersion:fitted.modelVersion})).rejects.toMatchObject({code:'MODEL_NOT_FOUND'});
 }finally{
  worker.kill('SIGTERM');await worker.exited;await rm(directory,{recursive:true,force:true});
 }
},30_000);
