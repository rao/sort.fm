import {expect,test} from 'bun:test';
import {FEATURE_VERSION, type FitResponse} from '@sortfm/contracts';
import {emptyMetrics} from '@sortfm/contracts/fixtures';
import {FeedbackWorker, type FeedbackRepository} from './feedback';
const lease={userId:'spotify:owner',feedbackRevision:3,leaseId:crypto.randomUUID()};
const response:FitResponse={userId:lease.userId,modelVersion:'untrained-v0',featureVersion:FEATURE_VERSION,feedbackRevision:3,trainedExamples:0,metrics:emptyMetrics};
function setup(fit:(id:string)=>Promise<FitResponse>,timeoutMs=100) {
  let pending=true;const ack:unknown[][]=[],retry:unknown[][]=[];
  const repository:FeedbackRepository={claimFeedbackSync:async()=>pending?(pending=false,{...lease}):null,acknowledgeFeedbackSync:async(...args)=>{ack.push(args);return true;},retryFeedbackSync:async(...args)=>{retry.push(args);}};
  const worker=new FeedbackWorker(repository,{fit},{now:()=>1000,timeoutMs,retryMs:30000});return {worker,ack,retry};
}
test('durable delivery acknowledges actual authoritative fitted revision, including newer snapshots',async()=>{
  const {worker,ack,retry}=setup(async id=>{expect(id).toBe(lease.userId);return {...response,feedbackRevision:4};});
  expect(await worker.runOnce()).toBe(true);expect(ack).toEqual([[lease.userId,lease.leaseId,4]]);expect(retry).toHaveLength(0);expect(await worker.runOnce()).toBe(false);
});
test('failed, stale or cross-user fit never acknowledges feedback and schedules durable retry',async()=>{
  for(const fit of [async()=>{throw new Error('network secret');},async()=>({...response,feedbackRevision:2}),async()=>({...response,userId:'spotify:other'})]) {
    const {worker,ack,retry}=setup(fit);await worker.runOnce();expect(ack).toHaveLength(0);expect(retry).toEqual([[lease.userId,lease.leaseId,31000]]);
  }
});
test('hung fit is bounded; acknowledgement failure survives for later reconciliation',async()=>{
  const {worker,retry}=setup(()=>new Promise(()=>{}),5);await worker.runOnce();expect(retry).toHaveLength(1);
  let retried=false;
  const db:FeedbackRepository={claimFeedbackSync:async()=>lease,acknowledgeFeedbackSync:async()=>{throw new Error('commit unavailable');},retryFeedbackSync:async()=>{retried=true;}};
  await new FeedbackWorker(db,{fit:async()=>response}).runOnce();expect(retried).toBe(true);
});
test('worker refuses unsafe deadline configuration and close drains active work',async()=>{
  const {worker}=setup(async()=>response);worker.start();await worker.close();
  expect(()=>new FeedbackWorker({} as FeedbackRepository,{fit:async()=>response},{timeoutMs:120000,leaseMs:120000})).toThrow('deadline');
});
