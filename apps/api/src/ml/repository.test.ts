import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type FitRequest,type FitResponse,type ScoreResponse,type ObserveRequest} from '@sortfm/contracts';
import {emptyMetrics,untrainedPrediction} from '@sortfm/contracts/fixtures';
import type {MlClient} from './client';
import {createRepositoryMl} from './repository';

const example:FitRequest['examples'][number]={trackId:'demo:one',decisionId:'00000000-0000-4000-8000-000000000001',
 label:0,split:'holdout',labeledAt:'2026-11-07T12:00:00Z',features:{featureVersion:FEATURE_VERSION,
 values:{energy:.3,saved_age_days:123},provenance:'synthetic',permittedForTraining:true}};
const response:FitResponse={userId:'demo:user',featureVersion:FEATURE_VERSION,modelVersion:'v1',feedbackRevision:7,trainedExamples:0,
 metrics:{...emptyMetrics,modelVersion:'v1',labeledExamples:1,heldOutExamples:1,heldOutNegative:1,evaluationMethod:'fixed_holdout'}};

test('fit sends one revision-consistent snapshot without rebuilding exposure-time features',async()=>{
 let reads=0;let actual:FitRequest|undefined;
 const repository={trainingExamples:async(userId:string)=>{expect(userId).toBe('demo:user');reads++;return {feedbackRevision:7,examples:[structuredClone(example)]};}};
 const client={fit:async(input:FitRequest)=>{actual=input;return response;}} as unknown as MlClient;
 const ml=createRepositoryMl({repository,client});
 expect(await ml.fit('demo:user')).toEqual(response);
 expect(reads).toBe(1);expect(actual).toEqual({userId:'demo:user',featureVersion:FEATURE_VERSION,feedbackRevision:7,evaluationSeed:42,examples:[example]});
});

test('empty authoritative snapshot can revoke all labels and retains database revision',async()=>{
 let actual:FitRequest|undefined;
 const ml=createRepositoryMl({repository:{trainingExamples:async()=>({feedbackRevision:8,examples:[]})},
 client:{fit:async(input:FitRequest)=>{actual=input;return response;}} as unknown as MlClient,evaluationSeed:9});
 await ml.fit('demo:user');expect(actual!.examples).toEqual([]);expect(actual!.feedbackRevision).toBe(8);expect(actual!.evaluationSeed).toBe(9);
});

test('scoring never reads feedback or waits on fit and preserves exact supplied exposure ID',async()=>{
 const candidate={trackId:example.trackId,features:example.features,exposureId:'00000000-0000-4000-8000-000000000002'};
 let actual:unknown;
 const result:ScoreResponse={userId:'demo:user',featureVersion:FEATURE_VERSION,modelVersion:'pinned',predictions:[{trackId:example.trackId,prediction:{...untrainedPrediction,modelVersion:'pinned'}}]};
 const ml=createRepositoryMl({repository:{trainingExamples:async()=>{throw new Error('must not load');}},client:{score:async(input:unknown)=>{actual=input;return result;}} as unknown as MlClient});
 expect(await ml.score('demo:user',[candidate],'pinned')).toEqual(result);
 expect(actual).toEqual({userId:'demo:user',featureVersion:FEATURE_VERSION,candidates:[candidate],modelVersion:'pinned'});
});

test('repository invalid snapshots fail before an HTTP call; errors propagate without made-up metrics',async()=>{
 let called=false;
 const ml=createRepositoryMl({repository:{trainingExamples:async()=>({feedbackRevision:-1,examples:[]})},
 client:{fit:async()=>{called=true;return response;}} as unknown as MlClient});
 await expect(ml.fit('demo:user')).rejects.toThrow();expect(called).toBe(false);
 const unavailable=new Error('safe unavailable');
 const failed=createRepositoryMl({repository:{trainingExamples:async()=>{throw unavailable;}},client:{} as unknown as MlClient});
 await expect(failed.fit('demo:user')).rejects.toBe(unavailable);
});

test('reusable observe, evaluation, and explanation calls preserve caller event identity',async()=>{
 const event:ObserveRequest={userId:'demo:user',eventId:'00000000-0000-4000-8000-000000000003',decisionId:example.decisionId,
 exposureId:'00000000-0000-4000-8000-000000000002',trackId:example.trackId,feedbackRevision:8,
 operation:'revoke',label:null,features:example.features,occurredAt:example.labeledAt};
 const calls:unknown[]=[];
 const ml=createRepositoryMl({repository:{trainingExamples:async()=>({feedbackRevision:0,examples:[]})},client:{
  observe:async(value:unknown)=>{calls.push(value);return {accepted:true,feedbackRevision:8,modelVersion:'v2'};},
  evaluation:async(value:unknown)=>{calls.push(value);return emptyMetrics;},
  explain:async(value:unknown)=>{calls.push(value);return {exposureId:event.exposureId,prediction:untrainedPrediction};},
 } as unknown as MlClient});
 await ml.observe(event);await ml.evaluation('demo:user','v2');await ml.explain('demo:user',event.exposureId);
 expect(calls).toEqual([event,{userId:'demo:user',modelVersion:'v2'},{userId:'demo:user',exposureId:event.exposureId}]);
});
