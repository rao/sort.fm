import {expect,test} from 'bun:test';
import {selectCalibrationExperiment} from './experiment-selection';
import {row,prediction} from './test-fixtures';
const pool=Array.from({length:240},(_,i)=>({track:{...row(i+1).track,artists:[{id:`artist-${i}`,name:'Fixture'}]},features:{featureVersion:'sortfm.features.v1' as const,provenance:'spotify' as const,permittedForTraining:true,rightsBasis:'Test fixture',values:{saved_age_days:i*10,energy:(i%12)/11,duration_ms:100000+i*100}},prediction:{...prediction,removalProbability:.001}}));
test('Batch3 freezes ordered 40/20/0 with complete disjoint B ranking and correct SRS inclusion',()=>{
 const a=selectCalibrationExperiment(pool,42);
 expect(a.selected).toHaveLength(60);expect(a.selected.slice(0,40).every(s=>s.group==='A'&&s.assignment==='sealed_evaluation'&&s.selectionProbability===40/240&&s.selectionScore===null)).toBe(true);
 expect(a.selected.slice(40)).toEqual(a.replacementPool.slice(0,20));expect(a.replacementPool).toHaveLength(200);
 expect(a.replacementPool.every(s=>s.group==='B'&&s.assignment==='train'&&s.selectionProbability===null)).toBe(true);
 expect(new Set([...a.selected.slice(0,40),...a.replacementPool].map(s=>s.trackId)).size).toBe(240);
 expect(a).toEqual(selectCalibrationExperiment([...pool].reverse(),42));expect(a.selected).not.toEqual(selectCalibrationExperiment(pool,43).selected);
});
test('A ignores scores, features and artists; B never uses probability or entropy',()=>{
 const a=selectCalibrationExperiment(pool,42),changed=pool.map(p=>({...p,prediction:{...p.prediction,removalProbability:1-p.prediction.removalProbability}}));
 expect(selectCalibrationExperiment(changed,42)).toEqual(a);
 expect(selectCalibrationExperiment(pool.map(p=>({...p,track:{...p.track,artists:[{id:'one',name:'Same'}]},features:{...p.features,values:{}}})),42).selected.slice(0,40)).toEqual(a.selected.slice(0,40));
});
test('B covers save-age quartiles and diverse artists while missing features stay missing',()=>{
 const original=structuredClone(pool);const selected=selectCalibrationExperiment(pool,42).selected.slice(40),byId=new Map(pool.map(c=>[c.track.trackId,c]));
 expect(new Set(selected.map(s=>Math.floor(byId.get(s.trackId)!.features.values.saved_age_days/600))).size).toBe(4);
 expect(new Set(selected.map(s=>byId.get(s.trackId)!.track.artists[0]!.id)).size).toBe(20);expect(pool).toEqual(original);
 const sparse=pool.slice(0,60).map(p=>({...p,features:{...p.features,values:{}}}));expect(selectCalibrationExperiment(sparse,0).selected).toHaveLength(60);expect(sparse.every(c=>Object.keys(c.features.values).length===0)).toBe(true);
});
test('rejects insufficient/duplicate pools and invalid seeds; confident C1 needs no uncertainty quota',()=>{
 expect(()=>selectCalibrationExperiment(pool.slice(0,59),42)).toThrow();expect(()=>selectCalibrationExperiment([...pool,pool[0]!],42)).toThrow();
 for(const seed of [-1,.5,2147483648,NaN])expect(()=>selectCalibrationExperiment(pool,seed)).toThrow();
 expect(selectCalibrationExperiment(pool.slice(0,60),2147483647).replacementPool).toHaveLength(20);
});

test('v1 SHA256 counter BE words and Fisher-Yates order are pinned for seed 42',()=>{
 const candidates=Array.from({length:60},(_,i)=>({track:row(i+1).track,features:{featureVersion:'sortfm.features.v1' as const,provenance:'spotify' as const,permittedForTraining:true,values:{}},prediction}));
 const selected=selectCalibrationExperiment(candidates,42);
 expect(selected.selected.slice(0,10).map(s=>Number(s.trackId))).toEqual([46,58,12,22,4,3,60,53,20,5]);
 expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(selected)).digest('hex')).toBe('1a4b9d8da73c3786752cc2587c021844e48c776c5427bdc365073b365b89f9bf');
});
