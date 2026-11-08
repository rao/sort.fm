import {test,expect} from 'bun:test';
import {experimentDigests} from '../src/calibration-experiment';
import {experimentDraft,hash} from './calibration-experiment-fixtures';
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
