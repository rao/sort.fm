import {listeningSnapshot} from '../reviews/listening-test-fixtures';
import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type ScoringCandidate} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../ml/features';
import {CalibrationQueue} from './queue';
import {fixture,now,owner,row,prediction} from './test-fixtures';

test('deterministic diverse selection covers save-age quartiles and artists, independent of repository order and scores',async()=>{
 const rows=Array.from({length:80},(_,i)=>row(i+1)),a=fixture(rows),b=fixture([...rows].reverse());
 const scorer=(reverse:boolean)=>async(userId:string,candidates:ScoringCandidate[])=>({userId,featureVersion:FEATURE_VERSION,modelVersion:prediction.modelVersion,predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...prediction,removalProbability:reverse?1-Number(c.trackId)/100:Number(c.trackId)/100}}))});
 const first=await new CalibrationQueue(a.store,{now:()=>now,score:scorer(false)}).get(owner,{limit:8});
 const second=await new CalibrationQueue(b.store,{now:()=>now,score:scorer(true)}).get(owner,{limit:8});
 expect(first.items.map(i=>i.track.trackId)).toEqual(second.items.map(i=>i.track.trackId));
 expect(new Set(first.items.map(i=>Math.floor((Number(i.track.trackId)-1)/20))).size).toBe(4);
 expect(new Set(first.items.map(i=>i.track.artists[0]!.id)).size).toBe(8);
 expect(first.items.every(i=>i.exposure.selectionMethod==='deterministic_baseline'&&i.exposure.policyVersion==='calibration:metadata-diverse:v1'&&i.exposure.propensityEstimate===null)).toBe(true);
 expect(first.mode).toBe('calibration');expect(first.remaining).toBe(80);
 expect(first.items.map(i=>i.exposure.exposureId)).not.toEqual(second.items.map(i=>i.exposure.exposureId));
});

test('full current library supplies features while only store eligible IDs receive calibration exposures',async()=>{
 const f=fixture([row(1),row(2),row(3)]);f.rows[2]!.currentStatus='kept';for(const r of f.rows)r.track.artists=[{id:'same',name:'Same'}];
 f.store.calibrationCandidates=async()=>({library:f.rows,eligibleTrackIds:[row(2).track.trackId]});
 const result=await new CalibrationQueue(f.store,{now:()=>now,assemble:(rows,ctx)=>assembleLibraryCandidates(rows,{...ctx,now:new Date(ctx.now).toISOString()})}).get(owner,{limit:20});
 expect(result.items).toHaveLength(1);expect(result.remaining).toBe(1);expect(result.items[0]!.track.trackId).toBe(row(2).track.trackId);
 expect(f.exposures).toHaveLength(1);expect(f.exposures[0]!.features.values.artist_library_count).toBe(3);
 expect(f.exposures[0]!.features.values.energy).toBeUndefined();expect(f.exposures[0]!.features.permittedForTraining).toBe(false);
 expect(result.items[0]!.prediction.removalProbability).toBeNull();expect(result.fallbackReason).not.toBeNull();
});

test('keyed actual predictions and feature snapshots are durably stored before cards return',async()=>{
 const f=fixture();let ids:string[]=[];
 const queue=new CalibrationQueue(f.store,{score:async(userId,candidates)=>{ids=candidates.map(c=>c.exposureId!);return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};}});
 const result=await queue.get(owner,{limit:2});expect(result.fallbackReason).toBeNull();
 expect(ids).toEqual(result.items.map(i=>i.exposure.exposureId));expect(f.exposures.map(e=>e.prediction)).toEqual(result.items.map(i=>i.prediction));
 f.store.insertCalibrationExposure=async()=>{throw Object.assign(Error('stale'),{code:'STALE_EXPOSURE'});};
 await expect(queue.get(owner,{limit:2})).rejects.toMatchObject({code:'STALE_EXPOSURE'});
});

test('late scoring cannot mutate fallback features or reuse a scorer exposure ID',async()=>{
 const f=fixture();let ids:string[]=[];
 const result=await new CalibrationQueue(f.store,{scoreTimeoutMs:5,score:async(userId,candidates)=>{
  ids=candidates.map(c=>c.exposureId!);candidates[0]!.features.values.duration_ms=42;await Bun.sleep(30);
  return {userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions:candidates.map(c=>({trackId:c.trackId,prediction}))};
 }}).get(owner,{limit:2});
 expect(result.items.every(i=>!ids.includes(i.exposure.exposureId)&&i.prediction.removalProbability===null)).toBe(true);
 expect(f.exposures.every(e=>e.features.values.duration_ms!==42)).toBe(true);await Bun.sleep(40);
});

test('wrong owner, missing, duplicate and mixed-model predictions safely fall back',async()=>{
 for(const fault of ['owner','missing','duplicate','version']){
  const f=fixture();
  const result=await new CalibrationQueue(f.store,{score:async(userId,candidates)=>{
   const predictions=candidates.map(c=>({trackId:c.trackId,prediction:{...prediction}}));
   if(fault==='missing')predictions.pop();if(fault==='duplicate')predictions[1]=predictions[0]!;if(fault==='version')predictions[0]!.prediction.modelVersion='wrong';
   return {userId:fault==='owner'?'foreign':userId,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,predictions};
  }}).get(owner,{limit:2});
  expect(result.items.every(i=>i.prediction.modelKind==='untrained')).toBe(true);expect(result.fallbackReason).toContain('unavailable');
 }
});

test('rejects corrupt eligibility and assembly; no synthetic/unplayable/completed/pending track is served',async()=>{
 for(const corrupt of ['duplicate','unknown','unplayable','kept','complete','pending','synthetic']){
  const f=fixture([row(1)]),r=f.rows[0]!;let eligible=[r.track.trackId];
  if(corrupt==='duplicate')eligible.push(r.track.trackId);if(corrupt==='unknown')eligible=[row(2).track.trackId];
  if(corrupt==='unplayable')r.track.isPlayable=false;if(corrupt==='kept')r.currentStatus='kept';
  if(['complete','pending'].includes(corrupt))r.currentDecision={status:corrupt==='complete'?'COMPLETE':'PENDING'} as never;
  if(corrupt==='synthetic')r.track={...r.track,source:'synthetic',spotifyUri:null};
  f.store.calibrationCandidates=async()=>({library:f.rows,eligibleTrackIds:eligible});
  await expect(new CalibrationQueue(f.store).get(owner,{limit:1})).rejects.toThrow();expect(f.exposures).toHaveLength(0);
 }
 const f=fixture();await expect(new CalibrationQueue(f.store,{assemble:()=>[]}).get(owner,{limit:1})).rejects.toThrow();
});

test('empty queue does not score and a 2768-track missing-audio library remains usable',async()=>{
 const empty=fixture([]);let calls=0;
 const result=await new CalibrationQueue(empty.store,{score:async()=>{calls++;throw Error();}}).get(owner,{limit:20});
 expect(result.items).toHaveLength(0);expect(result.fallbackReason).toBeNull();expect(calls).toBe(0);
 const f=fixture(Array.from({length:2768},(_,i)=>row(i+1)));
 const large=await new CalibrationQueue(f.store).get(owner,{limit:100});expect(large.items).toHaveLength(100);expect(large.remaining).toBe(2768);
});

test('awaits one full-library async load and keeps its features through scoring failure',async()=>{
 const f=fixture();let loads=0;
 await new CalibrationQueue(f.store,{now:()=>now,
  load:async(rows,ctx)=>{loads++;expect(rows).toHaveLength(f.rows.length);await Bun.sleep(1);return {listeningContext:listeningSnapshot(ctx.now),candidates:assembleLibraryCandidates(rows,{userId:ctx.userId,now:new Date(ctx.now).toISOString()}).map(c=>({...c,features:{...c.features,values:{...c.features.values,recent_play_count:2}}}))};},
  assemble:()=>{throw Error('legacy assembly must not run');},
  score:async(_owner,candidates)=>{expect(loads).toBe(1);candidates[0]!.features.values.recent_play_count=99;throw Error('offline');},
 }).get(owner,{limit:2});
 expect(loads).toBe(1);expect(f.exposures).toHaveLength(2);expect(f.exposures.every(e=>e.features.values.recent_play_count===2)).toBe(true);expect(f.exposures.map(e=>e.listeningContext)).toEqual(f.exposures.map(()=>listeningSnapshot(now)));
});
