/** Opt-in real C1 queue benchmark. Generated fixtures only; no DB or provider writes. */
import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {type ExposureInput,type FitRequest,type ScoringCandidate} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../ml/features';
import {createMlClient} from '../ml/client';
import {createRepositoryMl} from '../ml/repository';
import {QueueService,type LibraryRow} from './queue';

const frozenNow='2026-11-07T12:00:00Z';
const owner='demo:queue-ranking';
function fixtures():LibraryRow[]{
  return Array.from({length:2768},(_,i)=>{
    const id=String(i+1).padStart(22,'0');
    return {track:{trackId:id,spotifyUri:`spotify:track:${id}`,source:'spotify',title:`Generated fixture ${i+1}`,
      artists:[{id:'fixture-artist',name:'Fixture artist'}],album:'',imageUrl:null,durationMs:60_000+i*100,
      explicit:false,originalAddedAt:'2020-01-01T00:00:00Z',releaseDate:null,isPlayable:true},
      currentStatus:'saved',audioFeatures:null,currentDecision:null};
  });
}
// Spotify-shaped track DTOs exercise the real queue filter; the underlying values
// are generated here and explicitly attest synthetic provenance for this experiment.
function assemble(rows:LibraryRow[]):ScoringCandidate[]{
  return assembleLibraryCandidates(rows,{userId:owner,now:frozenNow,
    metadataTraining:{permittedForTraining:true,rightsBasis:'Original generated integration fixtures'}})
    .map(c=>({...c,features:{...c.features,provenance:'synthetic' as const}}));
}

test.skipIf(process.env.QUEUE_RANKING_INTEGRATION!=='1')('real C1 ranks 2768 missing-audio tracks, adapts after feedback fit, pins races and preserves explain',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'sortfm-queue-ranking-'));
  const reservation=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('reserved')});
  const port=reservation.port;await reservation.stop(true);
  const url=`http://127.0.0.1:${port}`,secret=crypto.randomUUID();
  const serviceRoot=fileURLToPath(new URL('../../../../services/ml',import.meta.url));
  const worker=Bun.spawn(['uv','run','--directory',serviceRoot,'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],
    {env:{...process.env,ML_SERVICE_SHARED_SECRET:secret,ML_ARTIFACT_DIR:directory},stdout:'ignore',stderr:'pipe'});
  try {
    let ready=false;
    for(let i=0;i<600;i++){
      try{ready=(await fetch(`${url}/health`)).ok;}catch{}
      if(ready)break;await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const rows=fixtures(),all=assemble(rows),stored:ExposureInput[]=[];
    let snapshot:{feedbackRevision:number;examples:FitRequest['examples']}={feedbackRevision:1,examples:[]};
    let trainingReads=0;
    const adapter=createRepositoryMl({client:createMlClient({serviceUrl:url,sharedSecret:secret}),repository:{trainingExamples:async user=>{
      expect(user).toBe(owner);trainingReads++;return structuredClone(snapshot);
    }}});
    const timings:{stage:'pool'|'selected';count:number;ms:number}[]=[],queueTimes:{phase:string;ms:number}[]=[];
    let publishBetweenPasses=false,newVersion:string|undefined;
    const queue=new QueueService({library:async user=>{expect(user).toBe(owner);return rows;},
      insertExposure:async input=>{stored.push(structuredClone(input));}},
      {now:()=>Date.parse(frozenNow),assemble,score:async(user,candidates,version)=>{
        const started=performance.now();
        const result=await adapter.score(user,candidates,version);
        timings.push({stage:version?'selected':'pool',count:candidates.length,ms:Math.round(performance.now()-started)});
        if(!version){
          expect(candidates.every(c=>c.exposureId===undefined)).toBe(true);
          if(publishBetweenPasses){publishBetweenPasses=false;newVersion=(await adapter.fit(owner)).modelVersion;}
        }else expect(candidates.every(c=>c.exposureId!==undefined)).toBe(true);
        return result;
      }});
    const read=async(phase:string)=>{
      const started=performance.now();
      const result=await queue.get(owner,{limit:20,policy:'balanced',mode:'spotify'});
      queueTimes.push({phase,ms:Math.round(performance.now()-started)});
      expect(result.remaining).toBe(2768);expect(result.items).toHaveLength(20);
      return result;
    };
    const cold=await read('cold');
    expect(cold.items.every(i=>i.prediction.modelKind==='heuristic'&&i.prediction.removalProbability===null)).toBe(true);
    expect(cold.items[0]!.track.trackId).toBe(rows[0]!.track.trackId);
    expect(trainingReads).toBe(0);
    snapshot.examples=Array.from({length:60},(_,i)=>{
      const c=all[i*46]!;
      return {...c,decisionId:crypto.randomUUID(),label:(i>=30?1:0) as 0|1,split:i%5===0?'holdout':'train',labeledAt:frozenNow};
    });
    const fitted=await adapter.fit(owner);
    expect(fitted.trainedExamples).toBe(48);
    const first=await read('learned');
    expect(first.fallbackReason).toBeNull();
    expect(first.items[0]!.track.trackId).toBe(rows[2767]!.track.trackId);
    expect(first.items.every(i=>i.exposure.selectionMethod==='logistic_rank'&&i.prediction.modelVersion===fitted.modelVersion)).toBe(true);
    const old=structuredClone(stored);
    // Simulate a newer authoritative feedback snapshot after undo/review: same
    // immutable train/holdout assignments, new decision IDs and opposite labels.
    snapshot={feedbackRevision:2,examples:snapshot.examples.map(e=>({...e,decisionId:crypto.randomUUID(),label:(1-e.label) as 0|1}))};
    publishBetweenPasses=true;
    const raced=await read('publication-between-passes');
    expect(newVersion).not.toBe(fitted.modelVersion);
    expect(raced.items.map(i=>i.track.trackId)).toEqual(first.items.map(i=>i.track.trackId));
    expect(raced.items.every(i=>i.prediction.modelVersion===fitted.modelVersion)).toBe(true);
    const next=await read('new-feedback-model');
    expect(next.fallbackReason).toBeNull();
    expect(next.items[0]!.track.trackId).toBe(rows[0]!.track.trackId);
    expect(next.items.every(i=>i.prediction.modelVersion===newVersion)).toBe(true);
    for(let i=0;i<2;i++)expect((await read(`warm-${i+1}`)).items.map(x=>x.track.trackId)).toEqual(next.items.map(x=>x.track.trackId));
    expect(trainingReads).toBe(2); // Queue never asks for training data or calls fit.
    expect(stored.slice(0,old.length)).toEqual(old);
    expect(stored.every(s=>s.features.values.energy===undefined&&s.features.values.tempo_bpm===undefined)).toBe(true);
    for(const item of [cold.items[0]!,first.items[0]!]){
      expect((await adapter.explain(owner,item.exposure.exposureId)).prediction).toEqual(item.prediction);
      await expect(adapter.explain('demo:foreign',item.exposure.exposureId)).rejects.toMatchObject({code:'EXPOSURE_NOT_FOUND'});
    }
    const exposurePath=join(directory,createHash('sha256').update(owner).digest('hex'),'exposures.json');
    const exposures=JSON.parse(await readFile(exposurePath,'utf8'));
    expect(Object.keys(exposures).sort()).toEqual(stored.map(s=>s.exposure.exposureId).sort());
    expect(stored).toHaveLength(120); // 6 pages, never 6 * 2,768 unserved observations.
    expect(timings.filter(t=>t.stage==='pool').every(t=>t.count===2768)).toBe(true);
    expect(timings.filter(t=>t.stage==='selected').every(t=>t.count===20)).toBe(true);
    console.info('C1 queue benchmark (generated fixtures, in-memory repository):',JSON.stringify({queueTimes,timings}));
  } finally {
    worker.kill('SIGTERM');await worker.exited;await rm(directory,{recursive:true,force:true});
  }
},60_000);
