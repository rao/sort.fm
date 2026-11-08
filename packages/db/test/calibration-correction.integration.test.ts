import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import {createIdempotencyKey} from '@sortfm/contracts/client';
import type {CalibrationCorrectionInput,ReviewResult} from '@sortfm/contracts';
import {Database,json} from '../src/client';
import {buildApp} from '../../../apps/api/src/app';
import {loadConfig} from '../../../apps/api/src/config';
import {CalibrationService} from '../../../apps/api/src/calibration/service';
import {createCalibrationModule} from '../../../apps/api/src/calibration/module';
import {installPilotGuards} from '../../../apps/api/src/reviews/pilot';
import {migrate} from '../src/migrate';
import {Repository} from '../src/repository';
import {PostgresCalibrationStore} from '../src/calibration';
import {PostgresPolicyStore} from '../src/policy-store';
import {reviewExclusionManifestDigest} from '../src/review-exclusions';
import {policyFixture} from './policy-fixtures';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('explicit post-Skip preference correction',()=>{
 let db:Database;const clients:Database[]=[];
 beforeAll(async()=>{db=new Database(url!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`);await migrate(db);},60000);
 afterAll(async()=>{await Promise.all(clients.map(c=>c.close()));if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);
 async function fixture(pilot=true,excluded=false){
  const f=await policyFixture(db),policy=new PostgresPolicyStore(db),input=f.adaptive();
  const asOf=new Date().toISOString(),context={source:'spotify-recently-played' as const,completeHistory:false as const,sampleLimit:50 as const,status:'fresh' as const,asOf,fetchedAt:asOf,ageMs:0,windowStart:new Date(Date.parse(asOf)-30*86400000).toISOString(),cachedEventCount:3,uniqueEventCount:2,windowEventCount:1};
  if(input.draft.kind==='adaptive'){input.draft.listeningContext=context;input.draft.request.candidates[0]!.features.values.energy=null;}
  const prepared=await policy.prepareSelection(input),response=f.response(input);response.item.listeningContext=context;
  await policy.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:prepared.intent.lease!.leaseId,...response});
  const exposure=response.item,decisionId=crypto.randomUUID(),request={trackId:exposure.exposure.trackId,exposureId:exposure.exposure.exposureId,action:'SKIP' as const,idempotencyKey:createIdempotencyKey()};
  const first=await f.repo.createDecision({userId:f.userId,decisionId,request,requestFingerprint:'authored-skip',createdAt:new Date().toISOString()});
  const complete:ReviewResult={...first,status:'COMPLETE',mutationStep:'NONE',canUndo:true,label:null,labelState:'inactive',feedbackRevision:0,updatedAt:new Date().toISOString()};
  await f.repo.settleDecision(f.userId,complete,'PENDING','train');
  const manifest={ownerId:f.userId,pilotSchema:db.schema,sortedTrackIds:excluded?[request.trackId]:[]};
  const fenced=pilot?new Database(url!,db.schema,{reviewExclusions:{...manifest,sha256:reviewExclusionManifestDigest(manifest)}}):db;if(pilot)clients.push(fenced);
  const store=new PostgresCalibrationStore(fenced);
  const command=():CalibrationCorrectionInput=>({userId:f.userId,labelId:crypto.randomUUID(),exposureId:crypto.randomUUID(),request:{decisionId,label:1,idempotencyKey:createIdempotencyKey()},requestFingerprint:'authored-correction',createdAt:new Date().toISOString()});
  return {...f,store,fenced,exposure,decisionId,command};
 }
 async function immutable(userId:string){return db.transaction(async tx=>{const tables=['review_decisions','current_decisions','feedback','policy_selection_intents','policy_exposure_bindings','policy_delivery_events','policy_owner_state','exposure_consumptions','review_work','review_work_leases','spotify_mutations','saved_tracks','library_membership'];const result:Record<string,unknown>={};for(const table of tables){const [exists]=await tx`SELECT to_regclass(current_schema()||'.'||${table}) IS NOT NULL AS yes`;if(exists.yes)result[table]=await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE user_id=$1 ORDER BY to_jsonb(t)::text`,[userId]);}return result;});}
 test('one explicit Remove clones frozen evidence, creates train feedback and outbox; retry/Undo preserve original Skip and C2 ledger',async()=>{
  const f=await fixture(),before=await immutable(f.userId),input=f.command();
  const result=await f.store.correctSkippedPreference(input);expect(result).toMatchObject({submittedLabel:1,label:1,state:'active',trackId:f.tracks[0]!.trackId,canUndo:true,feedbackRevision:1});
  const [saved]=await db.transaction(tx=>tx`SELECT e.payload,e.purpose,l.request,l.split FROM calibration_labels l JOIN exposures e USING(user_id,exposure_id) WHERE l.user_id=${f.userId} AND l.label_id=${result.labelId}`);
  expect(saved.purpose).toBe('calibration');expect(saved.split).toBe('train');expect(saved.request.originalCorrectionRequest).toEqual(input.request);
  expect(saved.payload.features).toEqual(f.exposure.features);expect(saved.payload.prediction).toEqual(f.exposure.prediction);expect(saved.payload.listeningContext).toEqual(f.exposure.listeningContext);
  expect(saved.payload.exposure).toMatchObject({selectionMethod:'deterministic_baseline',policyVersion:'post-collection:skip-correction:v1',explorationCoefficient:0,propensityEstimate:null});expect(saved.payload.exposure.policyTelemetry).toBeUndefined();
  expect((await f.repo.trainingExamples(f.userId)).examples[0]).toMatchObject({label:1,split:'train',features:f.exposure.features});
  expect(await f.store.correctSkippedPreference({...input,labelId:crypto.randomUUID(),exposureId:crypto.randomUUID()})).toEqual(result);
  expect((await f.store.calibrationHistory(f.userId)).items).toEqual([result]);
  const undo={userId:f.userId,labelId:result.labelId,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'authored-undo',createdAt:new Date().toISOString()};
  const revoked=await f.store.undoCalibrationLabel(undo);expect(revoked).toMatchObject({state:'revoked',label:null,feedbackRevision:2,canUndo:false});expect(await f.store.correctSkippedPreference(input)).toEqual(revoked);expect(await f.store.undoCalibrationLabel(undo)).toEqual(revoked);
  expect((await f.repo.trainingExamples(f.userId)).examples).toEqual([]);expect(await immutable(f.userId)).toEqual(before);
  const [job]=await db.transaction(tx=>tx`SELECT target_revision FROM feedback_sync_jobs WHERE user_id=${f.userId}`);expect(job.target_revision).toBe(2);
 },60000);
 test('same request key cannot target another Skip and concurrent distinct commands yield exactly one active label',async()=>{
  const f=await fixture(),input=f.command(),results=await Promise.allSettled([f.store.correctSkippedPreference(input),f.store.correctSkippedPreference(f.command())]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'CALIBRATION_LABEL_ACTIVE'}});
  const accepted=results[0]!.status==='fulfilled'?input:null;
  if(accepted)await expect(f.store.correctSkippedPreference({...accepted,request:{...accepted.request,decisionId:crypto.randomUUID()}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect((await f.repo.trainingExamples(f.userId)).examples).toHaveLength(1);
 },60000);
 test('requires latest complete null-label Skip, present playable membership, and no unresolved mutation',async()=>{
  for(const kind of ['superseded','membership','unplayable','status','action','pending'] as const){
   const f=await fixture(false);await db.transaction(async tx=>{
    if(kind==='superseded')await tx`DELETE FROM current_decisions WHERE user_id=${f.userId}`;
    if(kind==='membership')await tx`DELETE FROM library_membership WHERE user_id=${f.userId} AND track_id=${f.tracks[0]!.trackId}`;
    if(kind==='unplayable')await tx`UPDATE tracks SET card=jsonb_set(card,'{isPlayable}','false') WHERE track_id=${f.tracks[0]!.trackId}`;
    if(kind==='status')await tx`UPDATE saved_tracks SET current_status='unliked' WHERE user_id=${f.userId} AND track_id=${f.tracks[0]!.trackId}`;
    if(kind==='action')await tx`UPDATE review_decisions SET request=jsonb_set(request,'{action}','"KEEP"') WHERE user_id=${f.userId} AND decision_id=${f.decisionId}`;
    if(kind==='pending')await tx`UPDATE review_decisions SET result=jsonb_set(result,'{status}','"FAILED_RETRYABLE"') WHERE user_id=${f.userId} AND decision_id=${f.decisionId}`;
   });
   await expect(f.store.correctSkippedPreference(f.command())).rejects.toMatchObject({code:kind==='pending'?'MUTATION_PENDING':'CALIBRATION_NOT_ELIGIBLE'});
   expect((await db.transaction(tx=>tx`SELECT 1 FROM calibration_labels WHERE user_id=${f.userId}`))).toHaveLength(0);
  }
 },60000);
 test('pilot rejects forbidden or unpublished source, and hides inherited ordinary calibration labels from history and Undo',async()=>{
  const excluded=await fixture(true,true);await expect(excluded.store.correctSkippedPreference(excluded.command())).rejects.toMatchObject({code:'REVIEW_TRACK_EXCLUDED'});
  const f=await fixture();await db.transaction(tx=>tx`UPDATE policy_exposure_bindings SET published=false WHERE user_id=${f.userId}`);await expect(f.store.correctSkippedPreference(f.command())).rejects.toMatchObject({code:'REVIEW_EXPOSURE_NOT_PUBLISHED'});
  const normal=new PostgresCalibrationStore(db),e=f.item(1);await normal.insertCalibrationExposure(e);const label=await normal.createCalibrationLabel({userId:f.userId,labelId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'ordinary',createdAt:new Date().toISOString()});
  expect((await f.store.calibrationHistory(f.userId)).items).toEqual([]);await expect(f.store.undoCalibrationLabel({userId:f.userId,labelId:label.labelId,commandId:crypto.randomUUID(),request:{idempotencyKey:createIdempotencyKey()},requestFingerprint:'ordinary-undo',createdAt:new Date().toISOString()})).rejects.toMatchObject({code:'CALIBRATION_LABEL_NOT_FOUND'});
 },60000);
 test('historical holdout remains forbidden after revocation; current live reservations block correction',async()=>{
  const holdout=await fixture(false);await db.transaction(tx=>tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${holdout.userId},${holdout.decisionId},1,NULL,true,'holdout',clock_timestamp())`);
  await expect(holdout.store.correctSkippedPreference(holdout.command())).rejects.toMatchObject({code:'CALIBRATION_NOT_ELIGIBLE'});
  const f=await fixture(false);await db.transaction(tx=>tx`UPDATE policy_exposure_bindings SET closed_at=NULL,closure_reason=NULL,expires_at=clock_timestamp()+interval '5 minutes' WHERE user_id=${f.userId}`);
  await expect(f.store.correctSkippedPreference(f.command())).rejects.toMatchObject({code:'MUTATION_PENDING'});
 },60000);

 test('all batch reservations, including revoked train and skipped sealed, block correction',async()=>{
  for(const [group,assignment,status] of [['B','train','revoked'],['A','sealed_evaluation','skipped']] as const){
   const f=await fixture(false),batchId=crypto.randomUUID(),exposureId=crypto.randomUUID();
   await db.transaction(async tx=>{
    const e={...f.exposure,exposure:{...f.exposure.exposure,exposureId}};
    await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${exposureId},${f.userId},${f.tracks[0]!.trackId},${json(e)}::jsonb,clock_timestamp(),'calibration')`;
    await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot) VALUES(${batchId},${f.userId},'calibration-batch2-v1',42,'authored-v1','authored-model',clock_timestamp(),'{}')`;
    await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,status,exposure_id) VALUES(${crypto.randomUUID()},${f.userId},${batchId},${f.tracks[0]!.trackId},${group},${assignment},'{}','{}',clock_timestamp(),0,${status},${exposureId})`;
   });
   await expect(f.store.correctSkippedPreference(f.command())).rejects.toMatchObject({code:'BATCH_TRACK_RESERVED'});expect((await f.repo.trainingExamples(f.userId)).examples).toEqual([]);
  }
 },60000);
 test('outbox failure rolls back generated exposure, label and revision; same key can safely retry',async()=>{
  const f=await fixture(),input=f.command(),before=await immutable(f.userId);
  await db.transaction(async tx=>{await tx.unsafe("CREATE FUNCTION reject_correction_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AUTHORED_OUTBOX_FAILURE'; END $$");await tx.unsafe('CREATE TRIGGER reject_correction_outbox BEFORE INSERT OR UPDATE ON feedback_sync_jobs FOR EACH ROW EXECUTE FUNCTION reject_correction_outbox()');});
  try{
   await expect(f.store.correctSkippedPreference(input)).rejects.toThrow('AUTHORED_OUTBOX_FAILURE');expect(await f.repo.trainingExamples(f.userId)).toEqual({feedbackRevision:0,examples:[]});
   expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE exposure_id=${input.exposureId}`)).toHaveLength(0);expect(await db.transaction(tx=>tx`SELECT 1 FROM calibration_labels WHERE user_id=${f.userId}`)).toHaveLength(0);expect(await immutable(f.userId)).toEqual(before);
  }finally{await db.transaction(tx=>tx.unsafe('DROP TRIGGER reject_correction_outbox ON feedback_sync_jobs'));}
  expect((await f.store.correctSkippedPreference(input)).state).toBe('active');
 },60000);
 test('real HTTP guard and DB composition recover response loss and reject inherited label Undo without provider access',async()=>{
  const f=await fixture(),guard=new Repository(f.fenced),origin='http://127.0.0.1:5173',headers={cookie:'sortfm_session=authored',origin};let kicks=0;
  const config={secureCookies:false,webOrigin:origin,apiOrigin:'http://127.0.0.1:3000'},auth={session:async(token?:string)=>token==='authored'?{user:{id:f.userId}}:null},service=new CalibrationService(f.store,{feedback:{kick(){kicks++;}}});
  const app=await buildApp({config:loadConfig({NODE_ENV:'test'}),beforeRoutes:app=>installPilotGuards(app,{config,auth,admission:{getPublishedExposure:(u,e)=>guard.getExposure(u,e),getDecision:(u,d)=>guard.getDecision(u,d),getDecisionByIdempotencyKey:(u,k)=>guard.getDecisionByIdempotencyKey(u,k),getUndoByIdempotencyKey:(u,k)=>guard.getUndoByIdempotencyKey(u,k)}}),registerRoutes:app=>createCalibrationModule({config,auth,service,correction:service,queue:{get:async()=>{throw Error('QUEUE_MUST_NOT_RUN');}}}).registerRoutes(app)});
  const payload=f.command().request,before=await immutable(f.userId);
  try{
   const first=await app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload});expect(first.statusCode).toBe(200);const label=first.json();
   const replay=await app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload});expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(label);expect(replay.headers['cache-control']).toBe('no-store');
   expect((await app.inject({url:'/api/calibration/history',headers})).json().items).toEqual([label]);
   const normal=new PostgresCalibrationStore(db),e=f.item(1);await normal.insertCalibrationExposure(e);const inherited=await normal.createCalibrationLabel({userId:f.userId,labelId:crypto.randomUUID(),request:{trackId:e.exposure.trackId,exposureId:e.exposure.exposureId,label:0,idempotencyKey:createIdempotencyKey()},requestFingerprint:'ordinary-http',createdAt:new Date().toISOString()});
   const denied=await app.inject({method:'POST',url:`/api/calibration/labels/${inherited.labelId}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID()}});expect(denied.statusCode).toBe(404);expect((await app.inject({url:'/api/calibration/history',headers})).json().items).toEqual([label]);
   const undo=await app.inject({method:'POST',url:`/api/calibration/labels/${label.labelId}/undo`,headers,payload:{idempotencyKey:crypto.randomUUID()}});expect(undo.statusCode).toBe(200);expect(undo.json()).toMatchObject({state:'revoked',label:null});
   expect((await app.inject({method:'POST',url:'/api/calibration/corrections',headers,payload})).json()).toEqual(undo.json());expect(await immutable(f.userId)).toEqual(before);expect(kicks).toBe(4);
  }finally{await app.close();}
 },60000);
});
