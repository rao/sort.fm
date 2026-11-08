import {createIdempotencyKey} from '@sortfm/contracts/client';
import {expect,test} from 'bun:test';
import {CALIBRATION_BATCH3_EXPERIMENT as experiment,CalibrationExperimentDraftSchema} from '@sortfm/contracts';
import {CalibrationExperimentService} from './experiment-service';
import {experimentFixture,operatorInput,digest} from './experiment-test-fixtures';
import {now,owner} from './test-fixtures';

test('operator reserve captures once, scores once, freezes sorted complete eligible pool; replay reads no candidates',async()=>{
 const f=experimentFixture(),input=operatorInput(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score});
 const first=await service.reserve(owner,input);expect(f.calls).toEqual(['snapshot','candidates','load','score','reserve']);
 const draft=CalibrationExperimentDraftSchema.parse(f.saved()!.draft);expect(draft.candidates).toHaveLength(80);expect(draft.eligibleTrackIdsSha256).toBe(digest(draft.candidates.map(c=>c.track.trackId)));expect(draft.selected).toHaveLength(60);expect(draft.replacementPool).toHaveLength(40);
 expect(draft.candidates.every(c=>c.features.values.recent_play_count===undefined)).toBe(true);
 expect(await service.reserve(owner,input)).toEqual(first);expect(f.calls.slice(5)).toEqual(['snapshot']);
 await expect(service.reserve(owner,{...input,research:{...input.research,protocolSha256:'f'.repeat(64)}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
test('rejects malformed commitment, chronology and exclusion digest before reading any candidate pool',async()=>{
 for(const fault of ['commitment','future','ledger']){
  const f=experimentFixture(),input=operatorInput();if(fault==='commitment')input.seedPrecommit.commitment='0'.repeat(64);if(fault==='future')input.seedPrecommit.committedAt=new Date(now+1).toISOString();if(fault==='ledger')input.exclusionLedger.sortedIdsSha256='0'.repeat(64);
  await expect(new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score}).reserve(owner,input)).rejects.toThrow();expect(f.calls).toEqual(fault==='future'?['snapshot']:[]);
 }
});
test('operator read/snapshot/skip never assemble or score or alter reserved snapshot',async()=>{
 const f=experimentFixture(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score});await service.reserve(owner,operatorInput());const before=structuredClone(f.saved());f.calls.length=0;
 expect((await service.read(owner,experiment))?.phase).toBe('reserved');expect(await service.snapshot(owner,experiment)).toEqual(before);
 await service.skip(owner,experiment,{exposureId:crypto.randomUUID(),idempotencyKey:createIdempotencyKey()});expect(f.calls).toEqual(['read','snapshot','skip']);expect(f.saved()).toEqual(before);
});
test('incoherent, untrained, wrong-owner or unavailable scoring cannot reserve any panel',async()=>{
 for(const fault of ['owner','missing','duplicate','version','kind','untrained','network']){
  const f=experimentFixture();const score=async(user:string,candidates:{trackId:string}[])=>{const response=await f.score(user,candidates);
   if(fault==='owner')response.userId='foreign';if(fault==='missing')response.predictions.pop();if(fault==='duplicate')response.predictions[1]=response.predictions[0]!;
   if(fault==='version')response.predictions[0]!.prediction.modelVersion='other';if(fault==='kind')response.predictions[0]!.prediction.modelKind='heuristic';if(fault==='untrained')response.predictions[0]!.prediction.trainedExamples=0;if(fault==='network')throw Error('private');return response;};
  await expect(new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score}).reserve(owner,operatorInput())).rejects.toMatchObject({code:'BATCH_SCORING_UNAVAILABLE'});expect(f.saved()).toBeNull();expect(f.calls).not.toContain('reserve');
 }
});
test('corrupt eligibility, insufficient pool and unpermitted features fail before scoring',async()=>{
 for(const fault of ['duplicate','unknown','short','excluded','permission']){
  const f=experimentFixture(),input=operatorInput(),capture=f.store.calibrationExperimentCandidates;
  if(fault==='excluded'){input.exclusionLedger.sortedTrackIds=[f.rows[10]!.track.trackId];input.exclusionLedger.sortedIdsSha256=digest(input.exclusionLedger.sortedTrackIds);}
  f.store.calibrationExperimentCandidates=async(...args)=>{const s=await capture(...args);if(fault==='duplicate')s.eligibleTrackIds.push(s.eligibleTrackIds[0]!);if(fault==='unknown')s.eligibleTrackIds[0]='9'.repeat(22);if(fault==='short')s.eligibleTrackIds=s.eligibleTrackIds.slice(0,59);if(fault==='excluded')s.eligibleTrackIds.push(input.exclusionLedger.sortedTrackIds[0]!);return s;};
  const load=async(...args:Parameters<typeof f.load>)=>{const result=await f.load(...args);if(fault==='permission')result.candidates.forEach(c=>c.features.permittedForTraining=false);return result;};
  await expect(new CalibrationExperimentService(f.store,{now:()=>now,load,score:f.score}).reserve(owner,input)).rejects.toThrow();expect(f.calls).not.toContain('score');expect(f.saved()).toBeNull();
 }
});

test('scorer mutations cannot rewrite frozen feature, metadata or coverage inputs',async()=>{
 const f=experimentFixture();const load=async(...args:Parameters<typeof f.load>)=>{const result=await f.load(...args);return {...result,listeningContext:{source:'spotify-recently-played' as const,completeHistory:false as const,sampleLimit:50 as const,status:'missing' as const,asOf:new Date(now).toISOString(),fetchedAt:null,ageMs:null,windowStart:new Date(now-30*86400000).toISOString(),cachedEventCount:null,uniqueEventCount:null,windowEventCount:null}};};
 const score=async(user:string,candidates:Parameters<NonNullable<import('./experiment-service').CalibrationExperimentOptions['score']>>[1])=>{
  const response=await f.score(user,candidates);candidates[0]!.features.values.recent_play_count=0;f.rows[10]!.track.title='mutated';return response;
 };
 await new CalibrationExperimentService(f.store,{now:()=>now,load,score}).reserve(owner,operatorInput());
 const draft=f.saved()!.draft;expect(draft.candidates[0]!.features.values.recent_play_count).toBeUndefined();expect(draft.candidates[0]!.track.title).not.toBe('mutated');expect(draft.candidates.every(c=>c.listeningContext?.status==='missing')).toBe(true);
});
test('a late score response cannot reserve a panel after timeout',async()=>{
 const f=experimentFixture();let resolve:((response:Awaited<ReturnType<typeof f.score>>)=>void)|undefined;
 const service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,scoreTimeoutMs:5,score:()=>new Promise(done=>{resolve=done;})});
 await expect(service.reserve(owner,operatorInput())).rejects.toMatchObject({code:'BATCH_SCORING_UNAVAILABLE'});resolve!(await f.score(owner,[]));await Bun.sleep(1);expect(f.saved()).toBeNull();expect(f.calls).not.toContain('reserve');
});
test('reservation fences propagate and corrupted saved snapshots fail without recapture',async()=>{
 const f=experimentFixture(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score}),input=operatorInput();
 const reserve=f.store.reserveCalibrationExperiment;f.store.reserveCalibrationExperiment=async()=>{throw Object.assign(Error('drift'),{code:'BATCH_CANDIDATES_CHANGED'});};
 await expect(service.reserve(owner,input)).rejects.toMatchObject({code:'BATCH_CANDIDATES_CHANGED'});expect(f.saved()).toBeNull();f.store.reserveCalibrationExperiment=reserve;
 await service.reserve(owner,input);f.saved()!.draft.candidates[0]!.features.values.duration_ms=1;f.calls.length=0;
 await expect(service.reserve(owner,input)).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});expect(f.calls).toEqual(['snapshot']);
});
test('private seal validates the immutable receipt and never loads, scores, or reads a newer snapshot',async()=>{
 const f=experimentFixture(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score});await service.reserve(owner,operatorInput());const saved=f.saved()!,byId=new Map(saved.draft.candidates.map(c=>[c.track.trackId,c]));
 const input={batchId:saved.draft.batchId,idempotencyKey:createIdempotencyKey(),expected:saved.reservation.digests,research:saved.draft.research,externalSealedAt:new Date(now+500).toISOString(),
  evaluationCandidates:saved.draft.selected.slice(0,40).map(s=>({trackId:s.trackId,features:byId.get(s.trackId)!.features})),queryGroups:Object.fromEntries(saved.draft.selected.slice(0,40).map(s=>[s.trackId,byId.get(s.trackId)!.track.artists[0]!.id])),
  artifacts:{modelSealSha256:saved.draft.research.modelSealSha256,candidatesSha256:'1'.repeat(64),queryGroupsSha256:'2'.repeat(64),ownerManifestSha256:'3'.repeat(64),panelReviewSha256:'4'.repeat(64),predictionsSha256:'5'.repeat(64),queryAuditSha256:'6'.repeat(64),predictionSealSha256:'7'.repeat(64)},
 };
 const receipt:import('@sortfm/contracts').CalibrationExperimentSealReceipt={batchId:input.batchId,experiment,idempotencyKey:input.idempotencyKey,requestFingerprint:digest(input),digests:input.expected,research:input.research,artifacts:input.artifacts,externalSealedAt:input.externalSealedAt,checkedAt:new Date(now+1000).toISOString(),readyAt:new Date(now+2000).toISOString(),everFeedbackCount:0 as const};
 f.calls.length=0;f.store.sealCalibrationExperiment=async(user,value)=>{f.calls.push('seal');expect(user).toBe(owner);expect(value).toEqual(input);return structuredClone(receipt);};
 expect(await service.seal(owner,input)).toEqual(receipt);expect(await service.seal(owner,input)).toEqual(receipt);expect(f.calls).toEqual(['seal','seal']);
 f.store.sealCalibrationExperiment=async()=>({...receipt,requestFingerprint:'0'.repeat(64)});await expect(service.seal(owner,input)).rejects.toMatchObject({code:'CALIBRATION_INVALID_RESPONSE'});
});

test('concurrent same-operator capture returns the first authoritative reservation after exact-draft conflict',async()=>{
 const f=experimentFixture(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score}),input=operatorInput();
 const reserve=f.store.reserveCalibrationExperiment;
 f.store.reserveCalibrationExperiment=async(user,draft)=>{await reserve(user,{...draft,selectedAt:new Date(now+1).toISOString()});throw Object.assign(Error('another capture won'),{code:'IDEMPOTENCY_CONFLICT'});};
 expect(await service.reserve(owner,input)).toEqual(f.saved()!.reservation);expect(f.calls).toEqual(['snapshot','candidates','load','score','reserve','snapshot']);
});
test('concurrent conflict with a different operator research commitment is never accepted',async()=>{
 const f=experimentFixture(),service=new CalibrationExperimentService(f.store,{now:()=>now,load:f.load,score:f.score});const reserve=f.store.reserveCalibrationExperiment;
 f.store.reserveCalibrationExperiment=async(user,draft)=>{await reserve(user,{...draft,research:{...draft.research,protocolSha256:'f'.repeat(64)}});throw Object.assign(Error('conflict'),{code:'IDEMPOTENCY_CONFLICT'});};
 await expect(service.reserve(owner,operatorInput())).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});expect(f.calls.filter(c=>c==='score')).toHaveLength(1);
});
