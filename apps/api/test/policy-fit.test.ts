import {expect,test} from 'bun:test';
import {FEATURE_VERSION,type FitResponse,type ObserveRequest,type ScoringCandidate} from '@sortfm/contracts';
import {emptyMetrics,untrainedPrediction} from '@sortfm/contracts/fixtures';
import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import type {RepositoryMl} from '../src/ml/repository';
import {createMlRetrainModule} from '../src/ml/retrain';
import {withPolicyFitReceipts} from '../src/policy-fit';

const userId='synthetic:policy-fit';
const response:FitResponse={userId,modelVersion:'untrained-v0',featureVersion:FEATURE_VERSION,
 feedbackRevision:17,trainedExamples:0,metrics:emptyMetrics};
function deferred<T>(){let resolve!:(value:T)=>void, reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function adapter(fit:RepositoryMl['fit']=async()=>response){
 const calls:{method:string;args:unknown[]}[]=[];
 const ml:RepositoryMl={fit,
  score:async(...args)=>{calls.push({method:'score',args});return {userId,featureVersion:FEATURE_VERSION,modelVersion:response.modelVersion,predictions:[]};},
  observe:async(...args)=>{calls.push({method:'observe',args});return {accepted:true,feedbackRevision:17,modelVersion:response.modelVersion};},
  evaluation:async(...args)=>{calls.push({method:'evaluation',args});return emptyMetrics;},
  explain:async(...args)=>{calls.push({method:'explain',args});return {exposureId:args[1],prediction:untrainedPrediction};},
 };return {ml,calls};
}

test('one actual fit records its exact response once and preserves the returned object',async()=>{
 const fits:string[]=[],records:unknown[][]=[];
 const {ml,calls}=adapter(async owner=>{fits.push(owner);return response;});
 const wrapped=withPolicyFitReceipts(ml,async(...args)=>{records.push(args);return true;});
 expect(await wrapped.fit(userId)).toBe(response);
 expect(fits).toEqual([userId]);expect(records).toEqual([[userId,response]]);
 expect(records[0]![1]).toBe(response);expect(calls).toEqual([]);
});

test('original fit failure remains the same error and never starts a receipt write',async()=>{
 const failure=new Error('fit failed');let writes=0;
 const {ml}=adapter(async()=>{throw failure;});
 await expect(withPolicyFitReceipts(ml,async()=>{writes++;return true;}).fit(userId)).rejects.toBe(failure);
 expect(writes).toBe(0);
});

test('an unavailable optional receipt store does not change successful C1 results',async()=>{
 let writes=0;const {ml}=adapter();
 expect(await withPolicyFitReceipts(ml,async()=>{writes++;return false;}).fit(userId)).toBe(response);
 expect(writes).toBe(1);
});

test('receipt failures are sanitized and never fail or repeat the C1 fit',async()=>{
 for(const synchronous of [false,true]){
  let fits=0,writes=0;const codes:string[]=[];
  const {ml,calls}=adapter(async()=>{fits++;return response;});
  const record=()=>{writes++;if(synchronous)throw Error('private receipt failure');return Promise.reject(Error('private receipt failure'));};
  expect(await withPolicyFitReceipts(ml,record,{onError:code=>codes.push(code)}).fit(userId)).toBe(response);
  expect(fits).toBe(1);expect(writes).toBe(1);expect(calls).toEqual([]);
  expect(codes).toEqual(['POLICY_FIT_RECEIPT_UNAVAILABLE']);
 }
});

test('a hanging receipt write has a bounded wait and its late rejection is handled',async()=>{
 const pending=deferred<boolean>();let fits=0,writes=0;const codes:string[]=[];
 const {ml,calls}=adapter(async()=>{fits++;return response;});
 const wrapped=withPolicyFitReceipts(ml,()=>{writes++;return pending.promise;},{timeoutMs:5,onError:code=>codes.push(code)});
 expect(await wrapped.fit(userId)).toBe(response);
 expect(codes).toEqual(['POLICY_FIT_RECEIPT_TIMEOUT']);expect(fits).toBe(1);expect(writes).toBe(1);expect(calls).toEqual([]);
 pending.reject(Error('late private receipt failure'));await Bun.sleep(0);
 expect(codes).toEqual(['POLICY_FIT_RECEIPT_TIMEOUT']);expect(writes).toBe(1);
});

test('late receipt success neither repeats the write nor changes the C1 return',async()=>{
 const pending=deferred<boolean>();let writes=0;const codes:string[]=[];const {ml}=adapter();
 expect(await withPolicyFitReceipts(ml,()=>{writes++;return pending.promise;},{timeoutMs:5,onError:code=>codes.push(code)}).fit(userId)).toBe(response);
 pending.resolve(true);await Bun.sleep(0);
 expect(writes).toBe(1);expect(codes).toEqual(['POLICY_FIT_RECEIPT_TIMEOUT']);
});

test('diagnostic callbacks cannot fail a fit even when they throw or reject',async()=>{
 const {ml}=adapter();
 for(const onError of [()=>{throw Error('diagnostic failure');},async()=>{throw Error('async diagnostic failure');}]){
  expect(await withPolicyFitReceipts(ml,async()=>{throw Error('receipt failure');},{onError}).fit(userId)).toBe(response);
 }
 await Bun.sleep(0);
});

test('a fit completing after the retrain HTTP deadline still writes its actual receipt',async()=>{
 const pending=deferred<FitResponse>(),recorded=deferred<void>();let fits=0;const records:unknown[][]=[];
 const {ml}=adapter(async()=>{fits++;return pending.promise;});
 const wrapped=withPolicyFitReceipts(ml,async(...args)=>{records.push(args);recorded.resolve();return true;});
 const config=loadConfig({NODE_ENV:'test'});
 const module=createMlRetrainModule({config:{...config,secureCookies:false},auth:{session:async()=>({user:{id:userId}})},ml:wrapped,timeoutMs:10});
 const app=await buildApp({config,registerRoutes:module.registerRoutes});
 try{
  const result=await app.inject({method:'POST',url:'/api/ml/retrain',headers:{cookie:'sortfm_session=fixture',origin:config.webOrigin},payload:{}});
  expect(result.statusCode).toBe(504);expect(result.json().code).toBe('ML_RETRAIN_TIMEOUT');expect(fits).toBe(1);expect(records).toEqual([]);
  pending.resolve(response);await recorded.promise;await Bun.sleep(0);
  expect(records).toEqual([[userId,response]]);expect(records[0]![1]).toBe(response);expect(fits).toBe(1);
 }finally{pending.resolve(response);await app.close();}
});

test('non-fit methods retain their identity, arguments and result behavior',async()=>{
 const {ml,calls}=adapter();let writes=0;
 const wrapped=withPolicyFitReceipts(ml,async()=>{writes++;return true;});
 for(const method of ['score','observe','evaluation','explain'] as const)expect(wrapped[method]).toBe(ml[method]);
 const candidates:ScoringCandidate[]=[{trackId:'synthetic:track',features:{featureVersion:FEATURE_VERSION,values:{},provenance:'synthetic',permittedForTraining:true}}];
 const event:ObserveRequest={userId,eventId:crypto.randomUUID(),decisionId:crypto.randomUUID(),exposureId:crypto.randomUUID(),trackId:'synthetic:track',feedbackRevision:17,operation:'revoke',label:null,features:candidates[0]!.features,occurredAt:'2026-11-08T01:00:00Z'};
 await wrapped.score(userId,candidates,'pinned');await wrapped.observe(event);
 expect(await wrapped.evaluation(userId,'pinned')).toBe(emptyMetrics);await wrapped.explain(userId,event.exposureId);
 expect(calls).toEqual([{method:'score',args:[userId,candidates,'pinned']},{method:'observe',args:[event]},{method:'evaluation',args:[userId,'pinned']},{method:'explain',args:[userId,event.exposureId]}]);expect(writes).toBe(0);
});

test.each([0,-1,NaN,Infinity,-Infinity,2_147_483_648])('rejects unsafe receipt timeout %s before any fit',timeoutMs=>{
 const {ml}=adapter();expect(()=>withPolicyFitReceipts(ml,async()=>true,{timeoutMs})).toThrow(RangeError);
});
