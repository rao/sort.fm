import {CalibrationBatchSchema,type CalibrationBatch} from '@sortfm/contracts';
import {calibrationFixture} from './calibration-fixture';
export function calibrationBatchFixture(){
 const f=calibrationFixture();let batch:CalibrationBatch|null=null,lost=false,skips=0;
 const make=()=>{
  const at='2026-11-07T12:00:00.000Z',modelVersion='test:frozen';
  const items=Array.from({length:70},(_,i)=>{const base=structuredClone(f.source[0]!);const trackId=String(100+i).padStart(22,'0');return {...base,track:{...base.track,source:'spotify' as const,trackId,spotifyUri:`spotify:track:${trackId}` as const},prediction:{...base.prediction,modelVersion},exposure:{...base.exposure,trackId,modelVersion,exposureId:crypto.randomUUID()}};});
  const entries=items.map((item,i)=>{const group=i<25?'A':i<50?'B':'C';return {batchItemId:crypto.randomUUID(),exposureId:item.exposure.exposureId,trackId:item.track.trackId,group,assignment:group==='A'?'sealed_evaluation':'train',samplingMethod:'test',selectionScore:group==='A'?null:.9,selectionProbability:group==='A'?.25:null,scoreKind:group==='A'?'seeded_random':group==='B'?'coverage_distance':'entropy_heuristic',selectedAt:at,status:'pending',replacementFor:null};});
  return CalibrationBatchSchema.parse({batchId:crypto.randomUUID(),experiment:'calibration-batch2-v1',seed:42,algorithmVersion:'test',modelVersion,selectedAt:at,candidateCount:100,target:70,labeled:0,trainingLabeled:0,sealedLabeled:0,groups:['A','B','C'].map(group=>({group,target:group==='C'?20:25,pending:group==='C'?20:25,labeled:0,skipped:0,revoked:0})),entries,queue:{contractVersion:'1.0.0',mode:'calibration',items,remaining:70,nextCursor:null,fallbackReason:null}});
 };
 const snapshot=()=>{
  if(!batch)return null;
  for(const entry of batch.entries){if(entry.status==='skipped')continue;const result=f.history.find(h=>h.exposureId===entry.exposureId);if(result)entry.status=result.state==='active'?'labeled':'revoked';}
  batch.groups=batch.groups.map(g=>{const e=batch!.entries.filter(e=>e.group===g.group);return {...g,labeled:e.filter(e=>e.status==='labeled').length,pending:e.filter(e=>['pending','revoked'].includes(e.status)).length,skipped:e.filter(e=>e.status==='skipped').length,revoked:e.filter(e=>e.status==='revoked').length};});
  batch.labeled=batch.groups.reduce((n,g)=>n+g.labeled,0);batch.sealedLabeled=batch.groups[0]!.labeled;batch.trainingLabeled=batch.labeled-batch.sealedLabeled;
  const result=structuredClone(batch);result.queue.items=result.queue.items.filter(i=>result.entries.some(e=>e.exposureId===i.exposure.exposureId&&['pending','revoked'].includes(e.status)));result.queue.remaining=result.queue.items.length;return CalibrationBatchSchema.parse(result);
 };
 const api={...f.api,calibrationBatch:async()=>({batch:snapshot()}),calibrationBatchCreate:async()=>{batch??=make();return snapshot()!;},calibrationBatchSkip:async(input:{exposureId:string})=>{
  const e=batch!.entries.find(e=>e.exposureId===input.exposureId)!;
  if(e.status!=='skipped'){
   e.status='skipped';skips++;const item=structuredClone(batch!.queue.items[0]!);const trackId=String(900+skips).padStart(22,'0');item.track.trackId=trackId;item.track.spotifyUri=`spotify:track:${trackId}`;item.exposure.trackId=trackId;item.exposure.exposureId=crypto.randomUUID();batch!.queue.items.push(item);
   batch!.entries.push({...e,status:'pending',trackId,exposureId:item.exposure.exposureId,batchItemId:crypto.randomUUID(),replacementFor:e.batchItemId});
  }
  if(lost){lost=false;throw Error('Skip response lost');}return snapshot()!;
 }};
 return {...f,api,loseSkip:()=>{lost=true;},skips:()=>skips};
}
