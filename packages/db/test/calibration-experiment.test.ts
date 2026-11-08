import {test,expect} from 'bun:test';
import {experimentDigests} from '../src/calibration-experiment';
import {experimentDraft,experimentSeal,hash} from './calibration-experiment-fixtures';
import {PostgresCalibrationExperimentStore} from '../src/calibration-experiment';
test('server recomputes complete draft, pool, roster, eligibility and seed commitments',()=>{
 const d=experimentDraft();expect(experimentDigests(d)).toEqual({snapshotSha256:hash(d),poolSha256:hash(d.candidates),rosterSha256:hash(d.selected),eligibleTrackIdsSha256:hash(d.candidates.map(c=>c.track.trackId))});
 for(const mutate of [(v:typeof d)=>v.eligibleTrackIdsSha256='f'.repeat(64),(v:typeof d)=>v.seedPrecommit.commitment='f'.repeat(64),(v:typeof d)=>v.exclusionLedger.sortedIdsSha256='f'.repeat(64)]){const bad=structuredClone(d);mutate(bad);expect(()=>experimentDigests(bad)).toThrow('BATCH_INVALID_DIGEST');}
});
import {PostgresCalibrationBatchStore} from '../src/calibration-batch';import type {Database} from '../src/client';import {createIdempotencyKey} from '@sortfm/contracts/client';
test('Batch2 rejects an existing Batch3 skip replay before projecting any Batch2 cards',async()=>{
 const input={exposureId:crypto.randomUUID(),idempotencyKey:createIdempotencyKey()};
 const tx:any=async(strings:TemplateStringsArray)=>{const sql=strings.join('?');if(sql.includes('FOR UPDATE'))return [{feedback_revision:0}];if(sql.includes('to_regclass'))return [{ready:true}];if(sql.includes('FROM calibration_batch_skips'))return [{exposure_id:input.exposureId,batch_item_id:crypto.randomUUID()}];if(sql.includes('calibration_batch_items'))return [{experiment:'calibration-batch3-v1'}];if(sql.includes('FROM calibration_batches'))return [];throw Error('UNEXPECTED_SQL');};
 const db={transaction:(work:any)=>work(tx)} as Database;
 await expect(new PostgresCalibrationBatchStore(db).skipCalibrationBatch('test:owner',input,new Date().toISOString())).rejects.toMatchObject({code:'BATCH_ITEM_NOT_FOUND'});
});

for(const advances of [true,false])test(`seal ${advances?'waits for a later observed database millisecond':'fails closed when database time never advances'}`,async()=>{
 const draft=experimentDraft(),checkedAt=new Date().toISOString();
 const reservation={batchId:draft.batchId,experiment:draft.experiment,reservedAt:draft.selectedAt,ownerRevision:draft.ownerRevision,digests:experimentDigests(draft)};
 const input=experimentSeal(draft,reservation),observed:string[]=[];let writes=0,waits=0;
 const tx:any=async(strings:TemplateStringsArray)=>{
  const sql=strings.join('?');
  if(sql.includes('FOR UPDATE'))return [{feedback_revision:0}];
  if(sql.includes('to_regclass'))return [{ready:true}];
  if(sql.includes('FROM calibration_batches'))return [{batch_id:draft.batchId,snapshot:draft,reservation,seal_receipt:null}];
  if(sql.includes('FROM unified_feedback'))return [{n:0}];
  if(sql.includes('clock_timestamp')){
   if(sql.includes('pg_sleep'))waits++;
   const time=advances&&observed.length>=3?new Date(Date.parse(checkedAt)+7).toISOString():checkedAt;
   observed.push(time);return [{now:new Date(time)}];
  }
  if(sql.startsWith('UPDATE calibration_experiments')){writes++;return [];}
  throw Error('UNEXPECTED_SQL');
 };
 const db={transaction:(work:any)=>work(tx)} as Database;
 const sealing=new PostgresCalibrationExperimentStore(db).sealCalibrationExperiment('test:owner',input);
 if(advances){const receipt=await sealing;expect(receipt.checkedAt).toBe(checkedAt);expect(receipt.readyAt).toBe(observed.at(-1)!);expect(Date.parse(receipt.readyAt)-Date.parse(receipt.checkedAt)).toBe(7);expect(writes).toBe(1);expect(waits).toBeGreaterThan(0);}
 else{await expect(sealing).rejects.toMatchObject({code:'BATCH_SEAL_CHRONOLOGY'});expect(writes).toBe(0);expect(waits).toBeGreaterThan(0);expect(waits).toBeLessThanOrEqual(20);}
});
