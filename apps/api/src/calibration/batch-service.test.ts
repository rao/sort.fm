import {listeningSnapshot} from '../reviews/listening-test-fixtures';
import {test,expect} from 'bun:test';
import {CalibrationBatchService} from './batch-service';
import {row,prediction,owner,now} from './test-fixtures';
import type {CalibrationBatchDraft,CalibrationBatchStore} from '@sortfm/contracts';
const rows=Array.from({length:100},(_,i)=>row(i+1));
function fixture(){let published:CalibrationBatchDraft|undefined,calls=0;const store={
 calibrationBatch:async()=>null,
 calibrationBatchCandidates:async()=>({library:rows,eligibleTrackIds:rows.slice(10).map(r=>r.track.trackId)}),
 createCalibrationBatch:async(_u:string,draft:CalibrationBatchDraft)=>{published=draft;return {batchId:draft.batchId};},
 } as unknown as CalibrationBatchStore;
 const score=async(userId:string,candidates:{trackId:string}[])=>{calls++;return {userId,modelVersion:prediction.modelVersion,featureVersion:'sortfm.features.v1' as const,predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...prediction,removalProbability:.5}}))};};
 return {store,score,published:()=>published,calls:()=>calls};}
test('freezes one model response and full feature snapshot; never selects reviewed IDs',async()=>{
 const f=fixture(),service=new CalibrationBatchService(f.store,{now:()=>now,score:f.score});await service.create(owner,{seed:42});
 expect(f.calls()).toBe(1);expect(f.published()!.selected).toHaveLength(70);expect(f.published()!.selected.some(s=>rows.slice(0,10).some(r=>r.track.trackId===s.trackId))).toBe(false);
 expect(new Set(f.published()!.candidates.map(c=>c.prediction.modelVersion))).toEqual(new Set([prediction.modelVersion]));
});
test('fails without a coherent trained C1 snapshot; does not fabricate uncertain selections',async()=>{
 const f=fixture();await expect(new CalibrationBatchService(f.store,{now:()=>now}).create(owner,{seed:42})).rejects.toMatchObject({code:'BATCH_SCORING_UNAVAILABLE'});
 await expect(new CalibrationBatchService(f.store,{now:()=>now,score:async()=>({...await f.score(owner,[]),predictions:[]})}).create(owner,{seed:42})).rejects.toMatchObject({code:'BATCH_SCORING_UNAVAILABLE'});expect(f.published()).toBeUndefined();
});
test('resume uses the persisted batch without calling model or candidate source',async()=>{
 const f=fixture();f.store.calibrationBatch=async()=>({seed:42,batchId:'saved'} as never);f.store.calibrationBatchCandidates=async()=>{throw Error('must not redraw');};
 expect(await new CalibrationBatchService(f.store,{score:f.score}).create(owner,{seed:42})).toMatchObject({batchId:'saved'});expect(f.calls()).toBe(0);
 await expect(new CalibrationBatchService(f.store,{score:f.score}).create(owner,{seed:43})).rejects.toMatchObject({code:'BATCH_SEED_CONFLICT'});
});

test('loads new batch candidates once, freezes values and never loads when resuming',async()=>{
 const f=fixture();let loads=0;
 const service=new CalibrationBatchService(f.store,{now:()=>now,score:f.score,
  load:async(library,ctx)=>{loads++;await Bun.sleep(1);return {listeningContext:listeningSnapshot(ctx.now),candidates:library.map(r=>({trackId:r.track.trackId,features:{featureVersion:'sortfm.features.v1' as const,provenance:'spotify' as const,permittedForTraining:false,values:{recent_play_count:2}}}))};},
  assemble:()=>{throw Error('legacy assembly must not run');},
 });
 await service.create(owner,{seed:42});expect(loads).toBe(1);expect(f.published()!.candidates.every(c=>c.features.values.recent_play_count===2)).toBe(true);expect(f.published()!.candidates.map(c=>c.listeningContext)).toEqual(f.published()!.candidates.map(()=>listeningSnapshot(now)));
 f.store.calibrationBatch=async()=>({seed:42,batchId:'saved'} as never);
 await service.create(owner,{seed:42});expect(loads).toBe(1);expect(f.calls()).toBe(1);
});

test('async assembly failure does not score or save a partial durable batch',async()=>{
 const f=fixture();await expect(new CalibrationBatchService(f.store,{score:f.score,load:async()=>{throw Error('failed snapshot');}}).create(owner,{seed:42})).rejects.toThrow('failed snapshot');
 expect(f.calls()).toBe(0);expect(f.published()).toBeUndefined();
});
