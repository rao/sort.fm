import {expect,test} from 'bun:test';
import {ReviewRequestSchema, type ReviewResult} from '@sortfm/contracts';
import {ReviewService} from './service';
import type {ReviewRepository} from './store';
const trackId='0000000000000000000001';
const request=ReviewRequestSchema.parse({trackId,action:'UNLIKE',exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID()});
const result:ReviewResult={...request,decisionId:crypto.randomUUID(),status:'COMPLETE',mutationStep:'UNLIKED',mode:'spotify',liked:false,archived:false,canUndo:true,label:1,labelState:'active',feedbackRevision:1,error:null,createdAt:'2026-11-07T00:00:00Z',updatedAt:'2026-11-07T00:00:01Z'};
function setup(overrides:Partial<ReviewRepository>) {
  let kicks=0;const repository={getDecisionByIdempotencyKey:async()=>null,getUndoByIdempotencyKey:async()=>null,...overrides} as ReviewRepository;
  return {service:new ReviewService(repository,{auth:{requireScopes:async()=>{}},worker:{kick:()=>{kicks++;}}}),kicks:()=>kicks};
}
test('completed destructive retry returns same result even after current library removal',async()=>{
  const {service,kicks}=setup({getDecisionByIdempotencyKey:async()=>result,library:async()=>{throw new Error('Must dedupe before membership');}});
  expect(await service.decide('spotify:owner',request)).toEqual(result);expect(kicks()).toBe(1);
  await expect(service.decide('spotify:owner',{...request,action:'KEEP'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
test('new decision requires matching owned exposure and current Spotify membership',async()=>{
  const missing=setup({getExposure:async()=>null});await expect(missing.service.decide('spotify:owner',request)).rejects.toMatchObject({code:'EXPOSURE_NOT_FOUND'});
  const gone=setup({getExposure:async()=>({exposure:{trackId}} as any),library:async()=>[]});await expect(gone.service.decide('spotify:owner',request)).rejects.toMatchObject({code:'TRACK_NOT_REVIEWABLE'});
});
test('Undo pending does not return original COMPLETE as success; retry only succeeds once UNDONE',async()=>{
  let command:any=null,current=result;
  const {service,kicks}=setup({getDecision:async()=>current,getUndoByIdempotencyKey:async()=>command,createUndo:async input=>(command=input)});
  const undo={idempotencyKey:crypto.randomUUID() as typeof request.idempotencyKey};
  await expect(service.undo('spotify:owner',result.decisionId,undo)).rejects.toMatchObject({code:'UNDO_PENDING',retryable:true});
  expect(command.decisionId).toBe(result.decisionId);expect(kicks()).toBe(1);
  await expect(service.undo('spotify:owner',crypto.randomUUID(),undo)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  current={...result,status:'UNDONE',mutationStep:'RESTORED',liked:true,label:null,labelState:'revoked',canUndo:false,feedbackRevision:2};
  expect(await service.undo('spotify:owner',result.decisionId,undo)).toEqual(current);
});
