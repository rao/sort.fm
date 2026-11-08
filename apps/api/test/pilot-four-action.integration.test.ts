/** Guarded four-action pilot: actual PostgreSQL + C1/C2 Python, authored Spotify only.
 * TEST_DATABASE_URL is explicit; never uses the production DATABASE_URL fallback.
 */
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,migrate,PostgresA1Store,Repository,reviewExclusionManifestDigest} from '@sortfm/db';
import {QueueResultSchema,ReviewResultSchema,CalibrationLabelResultSchema,PolicyAssociationEventSchema,PolicyAssociationReceiptSchema,PolicyReleaseReceiptSchema,PolicySelectRequestSchema,PolicyDiagnosticsSchema,type ExposureInput,type QueueResult,type ReviewResult,type PolicyAssociationEvent,type PolicyAssociationReceipt,type PolicyFitReceipt,type PolicySelectRequest} from '@sortfm/contracts';
import {demoTracks,createDemoQueue} from '@sortfm/contracts/fixtures';
import {buildRuntime} from '../src/runtime';
import {createMlClient,createPolicyClient,feedbackSplit} from '../src/ml';
const databaseUrl=process.env.TEST_DATABASE_URL;
const owner='pilot.four.actions.synthetic',userId=`spotify:${owner}`,origin='http://127.0.0.1:5173';
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
type Item=QueueResult['items'][number];
type Association={payload:PolicyAssociationEvent;receipt:PolicyAssociationReceipt|null;claimed_fit_receipt:PolicyFitReceipt|null;completed_at:Date|null;disposition:string|null};

test.skipIf(!databaseUrl)('full pilot: Keep0 / Archive1 / Skip-null / Unlike1, original C2 exposures, committed fit before rewards, correction isolation, Undo and release',async()=>{
 const db=new Database(databaseUrl!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`),repo=new Repository(db);
 let runtime:Runtime|undefined,ml:Awaited<ReturnType<typeof localMl>>|undefined;
 const provider=authoredSpotify();
 try{
  await migrate(db);
  await repo.upsertUser({id:userId,spotifyId:owner,displayName:'Authored four-action acceptance',avatarUrl:null});
  const ids:string[]=[];for(let n=1;ids.length<14;n++){const id=String(n).padStart(22,'0');if(feedbackSplit(userId,id)==='train')ids.push(id);}
  const tracks=ids.map((id,i)=>({...demoTracks[i%demoTracks.length]!,trackId:id,source:'spotify' as const,spotifyUri:`spotify:track:${id}` as const,isPlayable:true}));
  for(const id of ids)provider.liked.add(id);
  await repo.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved' as const})));
  await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:ids,sourceTotal:ids.length,observedAt:new Date().toISOString()}));

  // A permanent sealed assignment is independent of the extra operator denylist.
  // Only authored rows are seeded; no research examples or artifacts are read.
  const sealed=tracks[1]!,example=createDemoQueue().items[0]!,batchId=crypto.randomUUID(),batchItemId=crypto.randomUUID();
  const sealedExposure={...example.exposure,exposureId:crypto.randomUUID(),trackId:sealed.trackId};
  const frozen={track:sealed,prediction:example.prediction,features:{featureVersion:'sortfm.features.v1' as const,values:{},provenance:'synthetic' as const,permittedForTraining:false}};
  await repo.insertExposure({userId,exposure:sealedExposure,prediction:frozen.prediction,features:frozen.features});
  await db.transaction(async tx=>{
   await tx`UPDATE exposures SET purpose='calibration' WHERE exposure_id=${sealedExposure.exposureId}`;
   await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot)
    VALUES(${batchId},${userId},'calibration-batch2-v1',42,'authored-four-action',${frozen.prediction.modelVersion},${sealedExposure.servedAt},'{}'::jsonb)`;
   await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,status,exposure_id)
    VALUES(${batchItemId},${userId},${batchId},${sealed.trackId},'A','sealed_evaluation','{}'::jsonb,${JSON.stringify(frozen)}::jsonb,${sealedExposure.servedAt},0,'revoked',${sealedExposure.exposureId})`;
   await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${batchItemId},${sealedExposure.exposureId})`;
  });
  const sealedSnapshot=()=>db.transaction(tx=>tx`SELECT assignment,status,exposure_id,candidate FROM calibration_batch_items WHERE user_id=${userId}`);
  const sealedBefore=await sealedSnapshot();
  const payload={ownerId:userId,pilotSchema:db.schema,sortedTrackIds:[ids[0]!],allowSpotifyMutations:true};
  const manifest={...payload,sha256:reviewExclusionManifestDigest(payload)};
  ml=await localMl();
  const env={NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:db.schema,DEMO_MODE_ENABLED:'false',PUBLIC_WEB_ORIGIN:origin,
   PUBLIC_API_ORIGIN:'http://127.0.0.1:3001',ML_SERVICE_URL:ml.serviceUrl,ML_SERVICE_SHARED_SECRET:ml.sharedSecret,
   SPOTIFY_CLIENT_ID:'authored-client',SPOTIFY_ALLOWED_USER_IDS:owner,TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),SESSION_SECRET:'authored-four-action-session-'.repeat(3),
   METADATA_RIGHTS_BASIS:'Authored synthetic fixtures; no real library or model efficacy claim',C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:'epsilon_greedy'};
  const startRuntime=async(rollback=false)=>{
   runtime=await buildRuntime({env:{...env,...(rollback?{C2_POLICY_ENABLED:'false'}:{})},pilot:{manifest,approvedManifestSha256:manifest.sha256,oauthFetch:provider.fetch,mutationFetch:provider.fetch}});
   expect(runtime.startupIssues).toEqual([]);return runtime.app.listen({host:'127.0.0.1',port:0});
  };
  let base=await startRuntime();
  const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});expect(start.status).toBe(302);
  const authorization=new URL(start.headers.get('location')!);
  const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state:authorization.searchParams.get('state')!,code:'authored-code'})}`,{redirect:'manual',headers:{cookie:start.headers.getSetCookie()[0]!.split(';')[0]!}});
  expect(callback.status).toBe(302);
  const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('sortfm_session='))!.split(';')[0]!,headers={cookie,origin,'content-type':'application/json'};
  expect((await(await fetch(`${base}/api/me`,{headers})).json() as {capabilities:unknown}).capabilities).toEqual({spotifyRead:true,spotifyWrite:true,playback:false});
  for(const path of ['/api/library/sync','/api/ml/retrain','/api/player/token','/api/calibration/labels'])expect((await fetch(`${base}${path}`,{method:'POST',headers,body:'{}'})).status).toBe(403);
  const initialFit=await runtime!.pilot!.ml.fit(userId);
  expect(initialFit.feedbackRevision).toBe(0);expect(initialFit.metrics.labeledExamples).toBe(0);
  const queue=async()=>{
   const response=await fetch(`${base}/api/queue?limit=1`,{headers});expect(response.status).toBe(200);
   const q=QueueResultSchema.parse(await response.json());expect(q.items).toHaveLength(1);
   const item=q.items[0]!;expect([ids[0],sealed.trackId]).not.toContain(item.track.trackId);
   expect((await runtime!.pilot!.repository.getExposure(userId,item.exposure.exposureId))?.prediction).toEqual(item.prediction);
   return q;
  };
  const waitDecision=async(id:string,status:'COMPLETE'|'UNDONE')=>{
   let result:ReviewResult|null=null;await eventually('committed four-action decision',async()=>{result=await runtime!.pilot!.repository.getDecision(userId,id);return result?.status===status;});return result!;
  };
  const associations=():Promise<Association[]>=>db.transaction(tx=>tx`SELECT payload,receipt,claimed_fit_receipt,completed_at,disposition FROM policy_delivery_events WHERE user_id=${userId} AND kind='associate' ORDER BY sequence`);
  const waitFeedback=async(revision:number,labels:number,count:number,rewards:number)=>{
   if(revision>0)await eventually('actual C1 feedback acknowledgement',async()=>{const [job]=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);return Number(job?.acknowledged_revision)===revision;});
   await eventually('actual C2 association acknowledgement',async()=>{const rows=await associations();return rows.length===count&&rows.every(r=>r.completed_at!==null);});
   const metrics=await ml!.client.evaluation({userId});expect(metrics.labeledExamples).toBe(labels);
   const [fit]=await db.transaction(tx=>tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`);
   expect(fit).toMatchObject({model_version:metrics.modelVersion,feedback_revision:revision});
   const rows=await associations();
   for(const row of rows){const event=PolicyAssociationEventSchema.parse(row.payload),receipt=PolicyAssociationReceiptSchema.parse(row.receipt);
    expect(row.disposition).toBe('acknowledged');expect(receipt.eventId).toBe(event.eventId);expect(receipt.sequence).toBe(event.sequence);
    expect(receipt.fitReceipt).toEqual(row.claimed_fit_receipt!);expect(receipt.fitReceipt.synchronizedFeedbackRevision).toBeGreaterThanOrEqual(event.feedbackRevision);
    // A real successful fit response precedes every association using its receipt.
    const fitIndex=ml!.calls.findIndex(c=>c.path==='/fit'&&c.modelVersion===receipt.fitReceipt.modelVersion);
    const associateIndex=ml!.calls.findIndex(c=>c.path==='/policy/associate'&&c.eventId===event.eventId);
    expect(fitIndex).toBeGreaterThanOrEqual(0);expect(associateIndex).toBeGreaterThan(fitIndex);
   }
   const diagnostics=await ml!.diagnostics();expect(diagnostics.counts.activeRewards).toBe(rewards);expect(diagnostics.counts.feedbackEvents).toBe(count);
   return rows;
  };
  const assertDatabaseOutcome=async(result:ReviewResult,undone=false)=>{
   const [state]=await db.transaction(tx=>tx`SELECT s.current_status,
    EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id) AS member,
    (SELECT status FROM spotify_mutations m WHERE m.user_id=s.user_id AND m.decision_id=${result.decisionId}) AS mutation_status,
    (SELECT step FROM spotify_mutations m WHERE m.user_id=s.user_id AND m.decision_id=${result.decisionId}) AS mutation_step,
    EXISTS(SELECT 1 FROM archive_records a WHERE a.user_id=s.user_id AND a.decision_id=${result.decisionId}) AS archive_record
    FROM saved_tracks s WHERE s.user_id=${userId} AND s.track_id=${result.trackId}`);
   const destructive=result.action==='ARCHIVE'||result.action==='UNLIKE';
   expect(state).toEqual({current_status:undone?'saved':({KEEP:'kept',ARCHIVE:'archived',SKIP:'deferred',UNLIKE:'unliked'} as const)[result.action],
    member:undone||!destructive,mutation_status:destructive?(undone?'UNDONE':'COMPLETE'):null,
    mutation_step:destructive?(undone?'RESTORED':'UNLIKED'):null,archive_record:result.action==='ARCHIVE'});
  };
  const decisions:{item:Item;result:ReviewResult;frozen:ExposureInput|null}[]=[];
  let labels=0,associationsCount=0;
  for(const action of ['KEEP','ARCHIVE','UNLIKE','SKIP'] as const){
   const item=(await queue()).items[0]!,snapshot=await runtime!.pilot!.repository.getExposure(userId,item.exposure.exposureId),beforeWrites=provider.writes.length;
   expect(item.exposure.policyTelemetry).toBeDefined();expect(decisions.some(d=>d.item.track.trackId===item.track.trackId)).toBe(false);
   const body=JSON.stringify({trackId:item.track.trackId,exposureId:item.exposure.exposureId,action,idempotencyKey:crypto.randomUUID()});
   const response=await fetch(`${base}/api/decisions`,{method:'POST',headers,body});expect(response.status).toBe(202);
   const pending=ReviewResultSchema.parse(await response.json()),result=await waitDecision(pending.decisionId,'COMPLETE');
   const expectedLabel=action==='KEEP'?0:action==='SKIP'?null:1;
   expect(result.label).toBe(expectedLabel);expect(result.labelState).toBe(expectedLabel===null?'inactive':'active');
   expect(result.exposureId).toBe(item.exposure.exposureId);expect(result.trackId).toBe(item.track.trackId);
   await assertDatabaseOutcome(result);
   if(expectedLabel!==null)labels++;
   const rows=await waitFeedback(result.feedbackRevision,labels,++associationsCount,labels),last=rows.at(-1)!;
   expect(last.payload).toMatchObject({operation:'upsert',decisionId:result.decisionId,exposureId:item.exposure.exposureId,trackId:item.track.trackId,label:expectedLabel});
   expect(last.receipt!.eligibleForLearning).toBe(expectedLabel!==null);
   const training=(await runtime!.pilot!.repository.trainingExamples(userId)).examples;
   expect(training.find(x=>x.decisionId===result.decisionId)?.label??null).toBe(expectedLabel);
   expect(training.some(x=>x.trackId===sealed.trackId)).toBe(false);
   const destructive=action==='ARCHIVE'||action==='UNLIKE';
   expect(provider.liked.has(item.track.trackId)).toBe(!destructive);expect(result.liked).toBe(destructive?false:null);
   expect(provider.archived.has(item.track.trackId)).toBe(action==='ARCHIVE');expect(result.archived).toBe(action==='ARCHIVE'?true:null);
   if(!destructive)expect(provider.writes).toHaveLength(beforeWrites);
   if(action==='ARCHIVE'){
    const writes=provider.writes.slice(beforeWrites);const added=writes.findIndex(w=>w.method==='POST'&&w.path.endsWith('/items')),removed=writes.findIndex(w=>w.method==='DELETE');
    expect(added).toBeGreaterThanOrEqual(0);expect(removed).toBeGreaterThan(added);
   }
   const writesAfter=provider.writes.length;
   const replay=await fetch(`${base}/api/decisions`,{method:'POST',headers,body});expect(replay.status).toBe(200);expect((await replay.json() as ReviewResult).decisionId).toBe(result.decisionId);
   expect((await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify({...JSON.parse(body),idempotencyKey:crypto.randomUUID()})})).status).toBe(409);
   expect(provider.writes).toHaveLength(writesAfter);expect(await associations()).toHaveLength(associationsCount);
   const eligible=(await runtime!.pilot!.policyStore.reviewCandidates(userId)).eligibleTrackIds;
   if(action==='SKIP')expect(eligible).toContain(item.track.trackId);else expect(eligible).not.toContain(item.track.trackId);
   expect((await ml!.policy.exposure({userId,exposureId:item.exposure.exposureId})).reservation.closureReason).toBe(action==='SKIP'?'skip':null);
   expect(await runtime!.pilot!.repository.getExposure(userId,item.exposure.exposureId)).toEqual(snapshot);
   decisions.push({item,result,frozen:snapshot});
  }
  // An explicit completed-Skip correction is a fresh calibration example.
  // Its C1 fit/Undo must never rewrite the original decision or invent C2 reward.
  const originalSkip=decisions.find(d=>d.result.action==='SKIP')!;
  const originalDecisionBefore=await runtime!.pilot!.repository.getDecision(userId,originalSkip.result.decisionId);
  const originalExposureBefore=await runtime!.pilot!.repository.getExposure(userId,originalSkip.item.exposure.exposureId);
  const policyBefore=await associations();
  const correctionBody=JSON.stringify({decisionId:originalSkip.result.decisionId,label:1,idempotencyKey:crypto.randomUUID()});
  const correctionResponse=await fetch(`${base}/api/calibration/corrections`,{method:'POST',headers,body:correctionBody});
  expect(correctionResponse.status).toBe(200);
  const correction=CalibrationLabelResultSchema.parse(await correctionResponse.json());
  expect(correction).toMatchObject({mode:'calibration',trackId:originalSkip.item.track.trackId,submittedLabel:1,label:1,state:'active',canUndo:true});
  expect(correction.exposureId).not.toBe(originalSkip.item.exposure.exposureId);
  await waitFeedback(correction.feedbackRevision,labels+1,associationsCount,labels);
  const [correctionExposure]=await db.transaction(tx=>tx`SELECT purpose,payload FROM exposures WHERE user_id=${userId} AND exposure_id=${correction.exposureId}`);
  expect(correctionExposure.purpose).toBe('calibration');
  expect(correctionExposure.payload.features).toEqual(originalExposureBefore!.features);
  expect(correctionExposure.payload.prediction).toEqual(originalExposureBefore!.prediction);
  expect(correctionExposure.payload.listeningContext).toEqual(originalExposureBefore!.listeningContext);
  expect(correctionExposure.payload.exposure.policyTelemetry).toBeUndefined();
  const correctionExamples=(await runtime!.pilot!.repository.trainingExamples(userId)).examples;
  expect(correctionExamples.find(example=>example.decisionId===correction.labelId)).toMatchObject({label:1,trackId:originalSkip.item.track.trackId});
  expect(await runtime!.pilot!.repository.getDecision(userId,originalSkip.result.decisionId)).toEqual(originalDecisionBefore);
  expect(await runtime!.pilot!.repository.getExposure(userId,originalSkip.item.exposure.exposureId)).toEqual(originalExposureBefore);
  expect(await associations()).toEqual(policyBefore);
  const correctionReplay=await fetch(`${base}/api/calibration/corrections`,{method:'POST',headers,body:correctionBody});
  expect(correctionReplay.status).toBe(200);expect(CalibrationLabelResultSchema.parse(await correctionReplay.json())).toEqual(correction);
  const correctionUndoBody=JSON.stringify({idempotencyKey:crypto.randomUUID()}),correctionUndoPath=`${base}/api/calibration/labels/${correction.labelId}/undo`;
  const correctionUndoResponse=await fetch(correctionUndoPath,{method:'POST',headers,body:correctionUndoBody});expect(correctionUndoResponse.status).toBe(200);
  const correctionUndone=CalibrationLabelResultSchema.parse(await correctionUndoResponse.json());
  expect(correctionUndone).toMatchObject({labelId:correction.labelId,exposureId:correction.exposureId,label:null,state:'revoked',canUndo:false});
  await waitFeedback(correctionUndone.feedbackRevision,labels,associationsCount,labels);
  expect(await associations()).toEqual(policyBefore);
  expect(await runtime!.pilot!.repository.getDecision(userId,originalSkip.result.decisionId)).toEqual(originalDecisionBefore);
  expect(await runtime!.pilot!.repository.getExposure(userId,originalSkip.item.exposure.exposureId)).toEqual(originalExposureBefore);
  const correctionUndoReplay=await fetch(correctionUndoPath,{method:'POST',headers,body:correctionUndoBody});expect(correctionUndoReplay.status).toBe(200);
  expect(CalibrationLabelResultSchema.parse(await correctionUndoReplay.json())).toEqual(correctionUndone);
  expect((await runtime!.pilot!.repository.trainingExamples(userId)).examples.some(example=>example.decisionId===correction.labelId)).toBe(false);
  for(const decision of decisions){
   const beforeWrites=provider.writes.length,undoBody=JSON.stringify({idempotencyKey:crypto.randomUUID()}),path=`${base}/api/decisions/${decision.result.decisionId}/undo`;
   expect((await fetch(path,{method:'POST',headers,body:undoBody})).status).toBe(409);
   const result=await waitDecision(decision.result.decisionId,'UNDONE');expect(result).toMatchObject({label:null,labelState:'revoked',exposureId:decision.item.exposure.exposureId});
   await assertDatabaseOutcome(result,true);
   if(decision.result.label!==null)labels--;
   const rows=await waitFeedback(result.feedbackRevision,labels,++associationsCount,labels);
   expect(rows.at(-1)!.payload).toMatchObject({operation:'revoke',decisionId:result.decisionId,exposureId:decision.item.exposure.exposureId,label:null});
   expect(rows.at(-1)!.receipt!.eligibleForLearning).toBe(false);
   expect(provider.liked.has(decision.item.track.trackId)).toBe(true);
   const destructive=decision.result.action==='ARCHIVE'||decision.result.action==='UNLIKE';
   expect(provider.writes.length-beforeWrites).toBe(destructive?1:0);
   if(destructive)expect(provider.writes.at(-1)!.method).toBe('PUT');
   expect(provider.archived.has(decision.item.track.trackId)).toBe(decision.result.action==='ARCHIVE');
   expect((await runtime!.pilot!.policyStore.reviewCandidates(userId)).eligibleTrackIds).toContain(decision.item.track.trackId);
   const writesAfter=provider.writes.length;
   expect((await fetch(path,{method:'POST',headers,body:undoBody})).status).toBe(200);
   expect(provider.writes).toHaveLength(writesAfter);expect(await associations()).toHaveLength(associationsCount);
   expect(await runtime!.pilot!.repository.getExposure(userId,decision.item.exposure.exposureId)).toEqual(decision.frozen);
  }
  expect((await runtime!.pilot!.repository.trainingExamples(userId)).examples).toHaveLength(0);

  // Published reservation survives API/ML restart, then normal release is replayable.
  const activeQueue=await queue(),active=activeQueue.items[0]!,selects=ml.selects.length;
  await runtime!.close();runtime=undefined;await ml.restart();base=await startRuntime();
  expect((await queue()).items).toEqual(activeQueue.items);expect(ml.selects).toHaveLength(selects);
  const intent=(await runtime!.pilot!.policyStore.currentSelection(userId))!;
  const request={userId,requestId:intent.requestId,releaseId:crypto.randomUUID(),exposureIds:[active.exposure.exposureId],reason:'prefetch_discarded' as const};
  const released=await runtime!.pilot!.policyStore.releaseSelection(request);
  expect(await runtime!.pilot!.policyStore.releaseSelection(request)).toEqual(released);
  await eventually('normal C2 release delivery',async()=>{const [r]=await db.transaction(tx=>tx`SELECT completed_at FROM policy_delivery_events WHERE user_id=${userId} AND exposure_id=${active.exposure.exposureId} AND kind='release'`);return r?.completed_at!==null&&r?.completed_at!==undefined;});
  const [releaseEvent]=await db.transaction(tx=>tx`SELECT payload,receipt,disposition FROM policy_delivery_events WHERE user_id=${userId} AND exposure_id=${active.exposure.exposureId} AND kind='release'`);
  const receipt=PolicyReleaseReceiptSchema.parse(releaseEvent.receipt);expect(receipt.outcome).toBe('released');expect(releaseEvent.disposition).toBe('acknowledged');
  expect(await ml.policy.release(releaseEvent.payload)).toEqual(receipt);
  expect((await ml.policy.exposure({userId,exposureId:active.exposure.exposureId})).reservation.status).toBe('released');
  expect((await runtime!.pilot!.policyStore.reviewCandidates(userId)).eligibleTrackIds).toContain(active.track.trackId);

  // Lose the response after Python persists selection: fallback must release that
  // real reservation, without inventing a C2 reward or bypassing absence grace.
  ml.failSelection();const fallback=await queue(),fallbackItem=fallback.items[0]!;
  expect(fallbackItem.exposure.policyVersion).toBe('queue:c1-fallback:epsilon_greedy:v1');expect(fallbackItem.exposure.policyTelemetry).toBeUndefined();expect(fallback.fallbackReason).toContain('using C1');
  const fallbackResponse=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify({trackId:fallbackItem.track.trackId,exposureId:fallbackItem.exposure.exposureId,action:'SKIP',idempotencyKey:crypto.randomUUID()})});
  expect(fallbackResponse.status).toBe(202);await waitDecision(ReviewResultSchema.parse(await fallbackResponse.json()).decisionId,'COMPLETE');
  expect(await associations()).toHaveLength(associationsCount);
  await runtime!.close();runtime=undefined;const beforeRollback=ml.selects.length;base=await startRuntime(true);
  expect((await queue()).items[0]!.exposure.policyTelemetry).toBeUndefined();expect(ml.selects).toHaveLength(beforeRollback);
  expect(ml.selects.every(r=>r.candidates.every(c=>![ids[0],sealed.trackId].includes(c.trackId)))).toBe(true);
  expect(await sealedSnapshot()).toEqual(sealedBefore);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM policy_exposure_bindings WHERE user_id=${userId} AND track_id=${sealed.trackId}`)).toHaveLength(0);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM import_jobs`)).toHaveLength(0);
  await eventually('all committed policy delivery drained',async()=>!(await db.transaction(tx=>tx`SELECT 1 FROM policy_delivery_events WHERE user_id=${userId} AND completed_at IS NULL`)).length);
  const [abandoned]=await db.transaction(tx=>tx`SELECT b.published,b.closure_reason,e.receipt,e.disposition FROM policy_exposure_bindings b JOIN policy_delivery_events e USING(user_id,exposure_id) WHERE b.exposure_id=${ml!.failures[0]!} AND e.kind='release'`);
  expect(abandoned).toMatchObject({published:false,closure_reason:'abandoned',disposition:'acknowledged'});
  expect(PolicyReleaseReceiptSchema.parse(abandoned.receipt).outcome).toBe('released');
  expect(provider.writes.filter(w=>w.method==='DELETE')).toHaveLength(2);
  expect(provider.writes.filter(w=>w.method==='PUT')).toHaveLength(2);
 }finally{
  const failures:unknown[]=[];for(const cleanup of [()=>runtime?.close(),()=>ml?.close(),()=>db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`),()=>db.close()])try{await cleanup();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Disposable four-action acceptance cleanup failed');
 }
},180000);

function authoredSpotify(){
 const liked=new Set<string>(),archived=new Set<string>(),writes:{method:string;path:string}[]=[];
 const playlistId='0000000000000000000099';let playlist=false;
 const object={id:playlistId,public:false,owner:{id:owner},description:`sort.fm archive [sortfm:${owner}]`};
 const fetcher=async(url:string,init?:RequestInit)=>{
  const parsed=new URL(url),method=init?.method??'GET',path=parsed.pathname,trackId=parsed.searchParams.get('uris')?.split(':').at(-1)!;
  if(url==='https://accounts.spotify.com/api/token')return Response.json({access_token:'authored-access',refresh_token:'authored-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-library-modify playlist-modify-private playlist-read-private'});
  if(path==='/v1/me')return Response.json({id:owner,display_name:'Authored four-action acceptance',images:[]});
  if(parsed.origin!=='https://api.spotify.com')throw Error('Unexpected authored provider host');
  if(method!=='GET')writes.push({method,path});
  if(path==='/v1/me/library/contains')return Response.json([liked.has(trackId)]);
  if(path==='/v1/me/library'&&['PUT','DELETE'].includes(method)){if(method==='DELETE')liked.delete(trackId);else liked.add(trackId);return new Response(null,{status:200});}
  if(path==='/v1/me/playlists'){if(method==='POST'){playlist=true;return Response.json(object);}return Response.json({offset:0,total:playlist?1:0,items:playlist?[object]:[]});}
  if(path===`/v1/playlists/${playlistId}`&&method==='GET')return Response.json(object);
  if(path===`/v1/playlists/${playlistId}/items`){
   if(method==='POST'){archived.add(JSON.parse(init!.body as string).uris[0].split(':').at(-1));return Response.json({snapshot_id:'authored-snapshot'});}
   return Response.json({offset:0,total:archived.size,items:[...archived].map(id=>({item:{id,type:'track'}}))});
  }
  throw Error('Unexpected authored Spotify endpoint');
 };
 return {liked,archived,writes,fetch:fetcher};
}

async function eventually(label:string,check:()=>Promise<boolean>,timeoutMs=25000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await Bun.sleep(100);}throw Error(`Timed out: ${label}`);}
async function localMl(){
 const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-pilot-realml-'));
 const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}),port=reservation.port!;await reservation.stop(true);
 const directUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
 const spawn=()=>Bun.spawn(['uv','run','--offline','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir},stdout:'ignore',stderr:'ignore'});
 let worker=spawn(),fail=false;const selects:PolicySelectRequest[]=[],failures:string[]=[],calls:{path:string;modelVersion?:string;eventId?:string}[]=[];
 const proxy=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const url=new URL(request.url);if(url.pathname==='/policy/select'){const r=PolicySelectRequestSchema.parse(await request.clone().json());selects.push(r);if(fail){const committed=await fetch(new Request(`${directUrl}${url.pathname}${url.search}`,request));if(!committed.ok)throw Error('Authored lost-response fixture requires successful real selection');failures.push(r.exposureId);return Response.json({code:'POLICY_STATE_UNAVAILABLE',message:'Authored lost select response',retryable:true},{status:503});}}
  const response=await fetch(new Request(`${directUrl}${url.pathname}${url.search}`,request));
  if(response.ok&&['/fit','/policy/associate'].includes(url.pathname)){const body=await response.clone().json() as {modelVersion?:string;eventId?:string};calls.push({path:url.pathname,modelVersion:body.modelVersion,eventId:body.eventId});}
  return response;
 }});
 const ready=()=>eventually('local Python readiness',async()=>{if(worker.exitCode!==null)throw Error('Local Python exited before readiness (offline uv cache required)');return Boolean((await fetch(`${directUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);},60000);
 const stopWorker=async()=>{if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;};
 const close=async()=>{try{await proxy.stop(true);}finally{try{await stopWorker();}finally{await rm(artifactDir,{recursive:true,force:true});}}};
 try{await ready();return {serviceUrl:`http://127.0.0.1:${proxy.port}`,sharedSecret,selects,failures,calls,close,diagnostics:async()=>PolicyDiagnosticsSchema.parse(await(await fetch(`${directUrl}/policy/diagnostics?${new URLSearchParams({userId})}`,{headers:{authorization:`Bearer ${sharedSecret}`}})).json()),failSelection:()=>{fail=true;},restart:async()=>{await stopWorker();worker=spawn();await ready();},client:createMlClient({serviceUrl:directUrl,sharedSecret}),policy:createPolicyClient({serviceUrl:directUrl,sharedSecret})};}
 catch(error){await close();throw error;}
}
