import {test,expect} from 'bun:test';
import {CalibrationBatchSelectionSchema,CalibrationBatchDraftSchema} from '../src/calibration-batch';
import {selectCalibrationBatch} from '../../../apps/api/src/calibration/batch-selection';
import {row,prediction,now} from '../../../apps/api/src/calibration/test-fixtures';
const candidates=Array.from({length:100},(_,i)=>({track:row(i+1).track,prediction:{...prediction,removalProbability:.5},features:{featureVersion:'sortfm.features.v1' as const,provenance:'spotify' as const,permittedForTraining:true,values:{saved_age_days:i}}}));
const draft=()=>({batchId:crypto.randomUUID(),seed:42,algorithmVersion:'calibration-batch2:v1',modelVersion:prediction.modelVersion,selectedAt:new Date(now).toISOString(),candidates,...selectCalibrationBatch(candidates,42)});
test('rejects assigning random evaluation to train or diverse/uncertain examples to evaluation',()=>{
 for(const group of ['A','B','C'] as const){const original=draft().selected.find(x=>x.group===group)!;expect(CalibrationBatchSelectionSchema.safeParse({...original,assignment:group==='A'?'train':'sealed_evaluation'}).success).toBe(false);}
});
test('draft rejects duplicate candidate IDs, mixed model versions and altered group sizes',()=>{
 const a=draft();expect(CalibrationBatchDraftSchema.safeParse(a).success).toBe(true);
 expect(CalibrationBatchDraftSchema.safeParse({...a,candidates:[...a.candidates.slice(1),a.candidates[1]]}).success).toBe(false);
 expect(CalibrationBatchDraftSchema.safeParse({...a,modelVersion:'other'}).success).toBe(false);
 expect(CalibrationBatchDraftSchema.safeParse({...a,selected:[...a.selected.slice(1),a.selected[1]]}).success).toBe(false);
});
