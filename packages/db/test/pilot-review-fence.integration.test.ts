import {PolicyQueueService} from '../../../apps/api/src/reviews/policy/queue';
import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {PostgresPolicyStore} from '../src/policy-store';import {policyFixture} from './policy-fixtures';import {reviewExclusionManifestDigest} from '../src/review-exclusions';import {createIdempotencyKey} from '@sortfm/contracts/client';import type {PrepareSelectionInput,ReviewResult} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('optional pilot review fence',()=>{
 let base:Database;const clients:Database[]=[];
 beforeAll(async()=>{base=new Database(url!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`);await migrate(base);},60000);
 afterAll(async()=>{await Promise.all(clients.map(d=>d.close()));if(base){await base.sql.unsafe(`DROP SCHEMA "${base.schema}" CASCADE`);await base.close();}},60000);
 async function fixture(denied=[0]){const f=await policyFixture(base),v={ownerId:f.userId,pilotSchema:base.schema,sortedTrackIds:denied.map(i=>f.tracks[i]!.trackId).sort()};const db=new Database(url!,base.schema,{reviewExclusions:{...v,sha256:reviewExclusionManifestDigest(v)}});clients.push(db);return {...f,db,guard:new Repository(db),policy:new PostgresPolicyStore(db),plain:new PostgresPolicyStore(base)};}
 const request=(f:Awaited<ReturnType<typeof fixture>>,i:number)=>{const e=f.item(i);return {userId:f.userId,decisionId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP' as const,idempotencyKey:createIdempotencyKey()},requestFingerprint:'synthetic',createdAt:new Date().toISOString()};};
 const allowed=(f:Awaited<ReturnType<typeof fixture>>):PrepareSelectionInput=>({...f.c1(),draft:{kind:'c1',items:[2,3].map((n,i)=>{const e=f.item(n);return {...e,exposure:{...e.exposure,position:i}};})}});
 test('fixed exclusions filter common eligibility and counts while preserving full library and training snapshots',async()=>{
  const f=await fixture([0,1]);const library=await f.repo.library(f.userId),training=await f.repo.trainingExamples(f.userId);
  const snapshot=await f.policy.reviewCandidates(f.userId);expect(snapshot.library).toEqual(library);expect(snapshot.remaining).toBe(3);expect(snapshot.eligibleTrackIds).toEqual(f.tracks.slice(2).map(t=>t.trackId));expect(await f.guard.trainingExamples(f.userId)).toEqual(training);
  await expect(f.policy.reviewCandidates('test:other')).rejects.toMatchObject({code:'REVIEW_OWNER_MISMATCH'});
  await expect(f.policy.prepareSelection(f.c1())).rejects.toMatchObject({code:'REVIEW_TRACK_EXCLUDED'});
  expect(await base.transaction(tx=>tx`SELECT 1 FROM policy_selection_intents WHERE user_id=${f.userId}`)).toHaveLength(0);
 },60000);
 test('forbidden prepared and published C1/adaptive intents cannot replay, publish or reach recovery',async()=>{
  for(const kind of ['c1','adaptive'] as const)for(const publish of [false,true]){
   const f=await fixture(),input=kind==='c1'?f.c1():f.adaptive(),p=await f.plain.prepareSelection(input),fence={userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId};
   const publication=kind==='c1'?{...fence,kind:'c1' as const}:{...fence,...f.response(input)};
   if(publish)await f.plain.publishSelection(publication);
   const result=await f.policy.prepareSelection(input);expect(result.outcome).toBe('closed');expect(result.intent.replayable).toBe(false);expect(result.intent.servableExposureIds).toEqual([]);
   expect((await f.policy.publishSelection(publication)).outcome).toBe('rejected');expect((await f.policy.currentSelection(f.userId))?.replayable??false).toBe(false);
   expect(await f.policy.claimSelectionRecovery({workerId:'synthetic',leaseMs:60000})).toBeNull();
   const [state]=await base.transaction(tx=>tx`SELECT (SELECT count(*)::int FROM policy_exposure_bindings WHERE user_id=${f.userId} AND closed_at IS NULL) AS active,(SELECT count(*)::int FROM exposures WHERE user_id=${f.userId}) AS exposures`);expect(state.active).toBe(0);expect(state.exposures).toBe(publish?(kind==='c1'?2:1):0);
  }
 },120000);
 test('inherited allowed exposures and historical idempotency/Undo/work cannot authorize pilot commands',async()=>{
  const f=await fixture(),e=f.item(2);await f.repo.insertExposure(e);const command={...request(f,2),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP' as const,idempotencyKey:createIdempotencyKey()}};const pending=await f.repo.createDecision(command);
  await expect(f.guard.getExposure(f.userId,e.exposure.exposureId)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  await expect(f.guard.getDecisionByIdempotencyKey(f.userId,command.request.idempotencyKey)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  await expect(f.guard.createDecision(command)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  await expect(f.guard.claimReviewWork('pilot',Date.now(),60000)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  const complete:ReviewResult={...pending,status:'COMPLETE',mutationStep:'NONE',canUndo:true,label:0,labelState:'active',feedbackRevision:1,updatedAt:new Date().toISOString()};await f.repo.settleDecision(f.userId,complete,'PENDING','train');
  const undo={userId:f.userId,commandId:crypto.randomUUID(),decisionId:command.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()};await f.repo.createUndo(undo);
  await expect(f.guard.getDecision(f.userId,command.decisionId)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});await expect(f.guard.getUndoByIdempotencyKey(f.userId,undo.request.idempotencyKey)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});await expect(f.guard.createUndo(undo)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  expect(await base.transaction(tx=>tx`SELECT 1 FROM review_work_leases WHERE user_id=${f.userId}`)).toHaveLength(0);
 },60000);
 test('new pilot publication admits KEEP/SKIP, exact retries and Undo after consumed bindings, without changing frozen training',async()=>{
  const f=await fixture(),input=allowed(f),p=await f.policy.prepareSelection(input),published=await f.policy.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:p.intent.lease!.leaseId,kind:'c1'});expect(published.outcome).toBe('published');
  const e=published.intent.publication!.items[0]!;expect(await f.guard.getExposure(f.userId,e.exposure.exposureId)).toEqual(e);
  await base.transaction(tx=>tx`UPDATE exposures SET payload=payload-'features' WHERE user_id=${f.userId} AND exposure_id=${e.exposure.exposureId}`);
  await expect(f.guard.getExposure(f.userId,e.exposure.exposureId)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  await base.transaction(tx=>tx`UPDATE exposures SET payload=${JSON.stringify(e)}::jsonb WHERE user_id=${f.userId} AND exposure_id=${e.exposure.exposureId}`);
  await base.transaction(tx=>tx`UPDATE exposures SET purpose='calibration' WHERE user_id=${f.userId} AND exposure_id=${e.exposure.exposureId}`);
  await expect(f.guard.getExposure(f.userId,e.exposure.exposureId)).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  await base.transaction(tx=>tx`UPDATE exposures SET purpose='review' WHERE user_id=${f.userId} AND exposure_id=${e.exposure.exposureId}`);
  await expect(f.guard.createDecision({...request(f,2),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'UNLIKE',idempotencyKey:createIdempotencyKey()}})).rejects.toMatchObject({code:'REVIEW_ACTION_NOT_ALLOWED'});
  await expect(f.guard.insertExposure({...e,exposure:{...e.exposure,exposureId:crypto.randomUUID()}})).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  const command={...request(f,2),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,action:'KEEP' as const,idempotencyKey:createIdempotencyKey()}},pending=await f.guard.createDecision(command);expect(await f.guard.createDecision(command)).toEqual(pending);
  const lease=(await f.guard.claimReviewWork('pilot',Date.now(),60000))!;expect(lease.decisionId).toBe(command.decisionId);
  const complete:ReviewResult={...pending,status:'COMPLETE',mutationStep:'NONE',canUndo:true,label:0,labelState:'active',feedbackRevision:1,updatedAt:new Date().toISOString()};await f.guard.settleDecision(f.userId,complete,'PENDING','train',{userId:f.userId,leaseId:lease.leaseId});await f.guard.completeReviewWork(f.userId,lease.leaseId);
  expect(await f.guard.getDecisionByIdempotencyKey(f.userId,command.request.idempotencyKey)).toEqual(complete);expect(await f.guard.createDecision(command)).toEqual(complete);
  await expect(f.guard.createDecision({...command,decisionId:crypto.randomUUID(),request:{...command.request,idempotencyKey:createIdempotencyKey()}})).rejects.toMatchObject({code:'POLICY_EXPOSURE_CLOSED'});
  const undo={userId:f.userId,commandId:crypto.randomUUID(),decisionId:command.decisionId,request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'undo',createdAt:new Date().toISOString()};expect(await f.guard.createUndo(undo)).toEqual(undo);expect(await f.guard.createUndo(undo)).toEqual(undo);expect(await f.guard.getUndoByIdempotencyKey(f.userId,undo.request.idempotencyKey)).toEqual(undo);
  expect((await f.guard.claimReviewWork('pilot',Date.now(),60000))!.operation).toBe('undo');
  expect(await f.guard.trainingExamples(f.userId)).toEqual(await f.repo.trainingExamples(f.userId));
 },60000);
 test('all three strategies and adaptive failure fallback share the same exclusion predicate',async()=>{
  for(const strategy of ['c1','epsilon_greedy','linucb'] as const){
   const f=await fixture([0,1]);await f.guard.recordPolicyFitReceipt(f.userId,f.fit(0));const sent:string[][]=[];
   const client:any={select:async(r:any)=>{sent.push(r.candidates.map((c:any)=>c.trackId));throw Error('SYNTHETIC_UNAVAILABLE');},exposure:async()=>{throw Error('UNEXPECTED_INSPECTION');}};
   const queue=new PolicyQueueService(f.policy,{enabled:true,strategy,client,assemble:rows=>rows.map(r=>({trackId:r.track.trackId,features:f.item().features}))});
   const result=await queue.get(f.userId,{limit:2,policy:'balanced',mode:'spotify'});expect(result.items).toHaveLength(2);expect(result.remaining).toBe(3);expect(result.items.every(i=>!f.db.reviewExclusions!.denies(f.userId,i.track.trackId))).toBe(true);
   expect(sent).toEqual(strategy==='c1'?[]:[f.tracks.slice(2).map(t=>t.trackId)]);
   if(strategy!=='c1')expect(result.items.every(i=>i.exposure.policyVersion===`queue:c1-fallback:${strategy}:v1`)).toBe(true);
   expect(await queue.get(f.userId,{limit:2,policy:'balanced',mode:'spotify'})).toEqual(result);
   for(const item of result.items)expect((await f.guard.getExposure(f.userId,item.exposure.exposureId))!.exposure.trackId).toBe(item.track.trackId);
  }
 },120000);
 test('direct recovery rejects an old forbidden adaptive draft before any remote selection',async()=>{
  const f=await fixture(),input=f.adaptive();await f.plain.prepareSelection(input);await base.transaction(tx=>tx`UPDATE policy_selection_intents SET lease_until=clock_timestamp()-interval '1 second' WHERE user_id=${f.userId}`);
  expect(await f.policy.claimSelectionRecovery({workerId:'synthetic',leaseMs:60000})).toBeNull();const [row]=await base.transaction(tx=>tx`SELECT status,lease_id FROM policy_selection_intents WHERE user_id=${f.userId}`);expect(row.status).toBe('release_pending');expect(row.lease_id).toBeNull();
 },60000);
});
