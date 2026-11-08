import {describe,test,expect} from 'bun:test';
import {selectCalibrationBatch} from './batch-selection';
import {row,prediction} from './test-fixtures';
const pool=Array.from({length:240},(_,i)=>{
 const r=row(i+1);r.track.artists=[{id:`artist-${i%100}`,name:`Artist ${i%100}`}];
 return {track:r.track,features:{featureVersion:'sortfm.features.v1' as const,provenance:'musicae' as const,permittedForTraining:true,values:{saved_age_days:i*10,energy:(i%12)/11,danceability:((i*5)%12)/11,happiness:((i*7)%12)/11,tempo_bpm:60+(i%12)*12,acousticness:((i*11)%12)/11}},prediction:{...prediction,removalProbability:.05+(i%20)/22}};
});
describe('Batch2 frozen sampling',()=>{
 test('70 unique eligible songs; deterministic despite ordering; seed changes selection',()=>{
  const a=selectCalibrationBatch(pool,42),b=selectCalibrationBatch([...pool].reverse(),42);
  expect(a).toEqual(b);expect(a.selected).toHaveLength(70);expect(new Set(a.selected.map(x=>x.trackId)).size).toBe(70);
  expect(['A','B','C'].map(g=>a.selected.filter(x=>x.group===g).length)).toEqual([25,25,20]);
  expect(a.selected.filter(x=>x.assignment==='sealed_evaluation')).toHaveLength(25);
  expect(selectCalibrationBatch(pool,43).selected).not.toEqual(a.selected);
 });
 test('random evaluation cohort is independent of predictions, audio and input ordering',()=>{
  const a=selectCalibrationBatch(pool,42),b=selectCalibrationBatch(pool.map(p=>({...p,prediction:{...p.prediction,removalProbability:1-p.prediction.removalProbability},features:{...p.features,values:{}}})),42);
  expect(a.selected.filter(x=>x.group==='A')).toEqual(b.selected.filter(x=>x.group==='A'));
 });
 test('B covers age and music regions without repeated primary artists; C maximizes entropy with artist diversity',()=>{
  const result=selectCalibrationBatch(pool,42);const byId=new Map(pool.map(x=>[x.track.trackId,x]));
  for(const g of ['B','C']){const selected=result.selected.filter(x=>x.group===g);expect(new Set(selected.map(x=>byId.get(x.trackId)!.track.artists[0]!.id)).size).toBe(selected.length);}
  const b=result.selected.filter(x=>x.group==='B').map(x=>byId.get(x.trackId)!.features.values);
  expect(new Set(b.map(x=>Math.min(3,Math.floor(x.saved_age_days/600)))).size).toBe(4);
  expect(Math.max(...b.map(x=>x.energy))-Math.min(...b.map(x=>x.energy))).toBeGreaterThan(.8);
  const c=result.selected.filter(x=>x.group==='C');expect(c.every(x=>x.scoreKind==='entropy_heuristic'&&x.selectionScore!>.97)).toBe(true);
 });
 test('missing audio remains neutral; pools contain only supplied unique never-reviewed candidates',()=>{
  const subset=pool.slice(70).map((x,i)=>i%3?x:{...x,features:{...x.features,values:{saved_age_days:x.features.values.saved_age_days}}});
  const result=selectCalibrationBatch(subset,7);expect(result.selected.every(x=>subset.some(p=>p.track.trackId===x.trackId))).toBe(true);
  expect(()=>selectCalibrationBatch([...pool,pool[0]!],42)).toThrow();expect(()=>selectCalibrationBatch(pool.slice(0,69),42)).toThrow();
 });
});

test('C does not fill artist diversity with confident predictions; insufficient ambiguous pool fails explicitly',()=>{
 const confident=pool.map((c,i)=>({...c,prediction:{...c.prediction,removalProbability:i<100?.5:.001}}));
 const result=selectCalibrationBatch(confident,42);expect(result.selected.filter(s=>s.group==='C').every(s=>s.selectionScore!>=.8)).toBe(true);expect(result.pools.C.every(s=>s.selectionScore!>=.8)).toBe(true);
 expect(()=>selectCalibrationBatch(pool.map(c=>({...c,prediction:{...c.prediction,removalProbability:.001}})),42)).toThrow('INSUFFICIENT_AMBIGUOUS_CANDIDATES');
});
