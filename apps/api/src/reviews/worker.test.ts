import {expect,test} from 'bun:test';
import type {ReviewResult} from '@sortfm/contracts';
import {ReviewWorker,type ReviewSpotify} from './worker';
import type {ReviewRepository,ReviewLease,Effect} from './store';
import {SpotifyError} from '../spotify/errors';
import {MutationRequestError} from '../spotify/mutations';

function setup(action:ReviewResult['action']='ARCHIVE') {
  const result:ReviewResult={decisionId:crypto.randomUUID(),trackId:'0000000000000000000001',action,exposureId:crypto.randomUUID(),idempotencyKey:crypto.randomUUID() as any,status:'PENDING',mutationStep:'PENDING',mode:'spotify',liked:null,archived:null,canUndo:false,label:null,labelState:'inactive',feedbackRevision:0,error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const lease:ReviewLease={userId:'spotify:owner',decisionId:result.decisionId,commandId:result.decisionId,operation:'review',leaseId:crypto.randomUUID(),result,mutation:null};
  let claimed=false,active=true,playlist:string|null=null,liked=true,archived=false,revision=0,retries=0;
  const effects=new Map<string,Effect>(),calls:string[]=[];
  const repo={claimReviewWork:async()=>claimed?null:(claimed=true,structuredClone(lease)),renewReviewWork:async()=>active,completeReviewWork:async()=>true,retryReviewWork:async()=>{retries++;return true;},trainingExamples:async()=>({feedbackRevision:revision,examples:[]}),getArchivePlaylist:async()=>playlist,setArchivePlaylist:async(_u:string,id:string)=>(playlist=id),getReviewEffect:async(_l:ReviewLease,kind:string)=>effects.get(kind)??null,
    beginReviewEffect:async(_l:ReviewLease,request:Effect['request'])=>{const existing=effects.get(request.kind);if(existing && existing.state!=='retryable')return {effect:existing,shouldExecute:false};const effect:Effect={request,state:'intent',remoteId:null};effects.set(request.kind,effect);return {effect,shouldExecute:true};},
    settleReviewEffect:async(_l:ReviewLease,kind:string,state:Effect['state'],remoteId:string|null)=>{const effect=effects.get(kind)!;effects.set(kind,{...effect,state,remoteId});if(kind==='create_archive'&&state==='confirmed')playlist=remoteId;},
    transitionMutation:async(value:any)=>{lease.mutation=value;},settleDecision:async(_u:string,value:ReviewResult)=>{lease.result=value;revision=value.feedbackRevision;},
  } as unknown as ReviewRepository;
  const spotify:ReviewSpotify={marker:()=> 'marker',findArchive:async()=>playlist,createArchive:async()=>{calls.push('create');return '0000000000000000000002';},verifyArchive:async()=>{calls.push('verify');},archiveContains:async()=>archived,addArchive:async()=>{calls.push('add');archived=true;},isLiked:async()=>liked,setLiked:async(_u,_t,value)=>{calls.push(value?'restore':'unlike');liked=value;}};
  const options={auth:{requireScopes:async()=>{}},retryMs:1};
  return {lease,repo,spotify,calls,effects,options,worker:new ReviewWorker(repo,spotify,options),retry:()=>{claimed=false;},loseLease:()=>{active=false;},retries:()=>retries,archive:(v:boolean)=>{archived=v;},liked:()=>liked};
}
test('archive inserts and confirms before unlike; complete emits one label then Undo revokes',async()=>{
  const s=setup();await s.worker.runOnce();expect(s.calls.indexOf('add')).toBeLessThan(s.calls.indexOf('unlike'));expect(s.lease.result).toMatchObject({status:'COMPLETE',label:1,labelState:'active',liked:false,archived:true});
  s.lease.operation='undo';s.lease.commandId=crypto.randomUUID();s.retry();await s.worker.runOnce();expect(s.lease.result).toMatchObject({status:'UNDONE',liked:true,label:null,labelState:'revoked',feedbackRevision:2});expect(s.calls.filter(x=>x==='add')).toHaveLength(1);
});
test('ambiguous add committed remotely reconciles after restart without a second POST',async()=>{
  const s=setup();s.spotify.addArchive=async()=>{s.calls.push('add');s.archive(true);throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Unconfirmed',503,true,'unknown');};
  await s.worker.runOnce();expect(s.lease.result.status).toBe('FAILED_RETRYABLE');expect(s.liked()).toBe(true);
  s.retry();await new ReviewWorker(s.repo,s.spotify,s.options).runOnce();expect(s.lease.result.status).toBe('COMPLETE');expect(s.calls.filter(x=>x==='add')).toHaveLength(1);
});
test('ambiguous add absent remotely remains unresolved without duplicate POST or unlike',async()=>{
  const s=setup();s.spotify.addArchive=async()=>{s.calls.push('add');throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Unconfirmed',503,true,'unknown');};
  await s.worker.runOnce();s.retry();await new ReviewWorker(s.repo,s.spotify,s.options).runOnce();expect(s.calls).not.toContain('unlike');expect(s.calls.filter(x=>x==='add')).toHaveLength(1);expect(s.lease.result.label).toBeNull();
});
test('definitive rate limit permits retry while partial archive success survives unlike failure',async()=>{
  const s=setup();let failures=1;const remove=s.spotify.setLiked;
  s.spotify.setLiked=async(...args)=>{if(failures--){throw new MutationRequestError('SPOTIFY_RATE_LIMITED','Wait',429,true,'rejected',Date.now()+1000);}return remove(...args);};
  await s.worker.runOnce();expect(s.lease.result.status).toBe('FAILED_RETRYABLE');s.retry();await s.worker.runOnce();expect(s.lease.result.status).toBe('COMPLETE');expect(s.calls.filter(x=>x==='add')).toHaveLength(1);
});
test('KEEP and SKIP never call Spotify; SKIP never produces a strong label',async()=>{
  for(const action of ['KEEP','SKIP'] as const){const s=setup(action);await s.worker.runOnce();expect(s.calls).toEqual([]);expect(s.lease.result.label).toBe(action==='KEEP'?0:null);expect(s.lease.result.status).toBe('COMPLETE');}
});
test('lost lease prevents remote writes and unconfirmed Undo retains original active label',async()=>{
  const lost=setup();lost.loseLease();await lost.worker.runOnce();expect(lost.calls).toEqual([]);
  const s=setup('UNLIKE');await s.worker.runOnce();s.lease.operation='undo';s.retry();s.spotify.setLiked=async()=>{throw new Error('remote down');};await s.worker.runOnce();expect(s.lease.result).toMatchObject({status:'COMPLETE',label:1,labelState:'active'});expect(s.retries()).toBe(1);
});


test('authorization loss after successful unlike remains recoverable and can later be undone',async()=>{
  const s=setup('UNLIKE'),read=s.spotify.isLiked;let reads=0;
  s.spotify.isLiked=async(...args)=>{if(++reads===2)throw new SpotifyError('SPOTIFY_REAUTH_REQUIRED','Reconnect',401);return read(...args);};
  await s.worker.runOnce();expect(s.liked()).toBe(false);expect(s.lease.result).toMatchObject({status:'FAILED_RETRYABLE',label:null,error:{retryable:true}});
  s.retry();await new ReviewWorker(s.repo,s.spotify,s.options).runOnce();expect(s.lease.result).toMatchObject({status:'COMPLETE',canUndo:true,label:1});expect(s.calls.filter(x=>x==='unlike')).toHaveLength(1);
});

test('SKIP replacing a prior strong decision advances revision while emitting no new label',async()=>{
  const s=setup('SKIP');s.repo.trainingExamples=async()=>({feedbackRevision:4,examples:[{trackId:s.lease.result.trackId,decisionId:crypto.randomUUID(),label:0,split:'train',labeledAt:new Date().toISOString(),features:{featureVersion:'sortfm.features.v1',values:{},provenance:'synthetic',permittedForTraining:true}}]});
  await s.worker.runOnce();expect(s.lease.result).toMatchObject({status:'COMPLETE',feedbackRevision:5,label:null,labelState:'inactive'});expect(s.calls).toEqual([]);
});
