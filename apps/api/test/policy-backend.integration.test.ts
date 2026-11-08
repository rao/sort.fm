import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Database,migrate,PostgresA1Store,PostgresPolicyStore,Repository} from '@sortfm/db';
import {
  AccountSessionSchema,CalibrationLabelResultSchema,CalibrationQueueResultSchema,
  DecisionHistorySchema,FitResponseSchema,LibraryImportStatusSchema,ModelInsightsSchema,
  PolicyAssociationEventSchema,PolicyAssociationReceiptSchema,PolicyDiagnosticsSchema,
  PolicyExposureSchema,PolicyReleaseReceiptSchema,PolicySelectRequestSchema,QueueResultSchema,ReviewResultSchema,
  type PolicyAssociationEvent,type PolicyAssociationReceipt,type PolicyFitReceipt,
  type PolicySelectRequest,type PublishedSelection,type QueueResult,type ReviewResult,type SelectionDraft,
} from '@sortfm/contracts';
import {createMlClient,createPolicyClient,feedbackSplit} from '../src/ml';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';

// Opt in explicitly. A production DATABASE_URL must never run this destructive-schema smoke.
const databaseUrl=process.env.TEST_DATABASE_URL;
const strategies=['c1','epsilon_greedy','linucb'] as const;
type Strategy=typeof strategies[number];
type Item=QueueResult['items'][number];
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
type AssociationRow={payload:PolicyAssociationEvent;receipt:PolicyAssociationReceipt|null;completed_at:Date|null;claimed_fit_receipt:PolicyFitReceipt|null;disposition:string|null};
const owner='controlled.policy.owner',userId=`spotify:${owner}`;
const origin='http://127.0.0.1:5173';

for(const strategy of strategies)test.skipIf(!databaseUrl)(
  `${strategy}: real backend/ML preserves committed rewards, replay, Undo, calibration and C1 fallback`,
  async()=>{
    const db=new Database(databaseUrl!,`test_policy_backend_${crypto.randomUUID().replaceAll('-','')}`);
    const repository=new Repository(db),provider=controlledSpotify();
    let runtime:Runtime|undefined,ml:Awaited<ReturnType<typeof localMl>>|undefined;
    try {
      await migrate(db);
      ml=await localMl();
      const makeRuntime=(overrides:Record<string,string>={})=>buildRuntime({env:{
        NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:db.schema,
        ML_SERVICE_URL:ml!.serviceUrl,ML_SERVICE_SHARED_SECRET:ml!.sharedSecret,
        METADATA_RIGHTS_BASIS:'Authored integration fixtures; no real account or efficacy claim',
        SPOTIFY_CLIENT_ID:'controlled-client',SPOTIFY_ALLOWED_USER_IDS:owner,
        TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),
        SESSION_SECRET:'controlled-policy-test-only-'.repeat(3),
        // Omitting both switches is the production-default C1 acceptance case.
        ...(strategy==='c1'?{}:{C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:strategy}),
        ...overrides,
      },spotifyHttp:new SpotifyHttp({fetch:provider.fetch}),spotifyMutationFetch:provider.fetch});
      runtime=await makeRuntime();
      expect(runtime.startupIssues).toEqual([]);
      const base=await runtime.app.listen({host:'127.0.0.1',port:0});
      const cookie=await login(base),headers={cookie,origin,'content-type':'application/json'};
      const sync=await fetch(`${base}/api/library/sync`,{method:'POST',headers,body:'{}'});
      expect(sync.status).toBe(202);
      await eventually('controlled library import',async()=>{
        const result=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers})).json());
        if(result.status==='failed')throw new Error('Controlled library import failed');
        return result.status==='complete'&&result.processed===provider.tracks.length;
      });
      expect((await repository.library(userId)).every(row=>row.audioFeatures===null)).toBe(true);
      const a1Store=new PostgresA1Store(db);
      const importedContext=await a1Store.transaction(tx=>tx.getTasteContext!(userId));
      expect(importedContext?.events).toHaveLength(4); // Provider supplied five events; one was an exact duplicate.

      // No inferred model/version: the actual empty fit must durably establish revision zero.
      const fitResponse=await fetch(`${base}/api/ml/retrain`,{method:'POST',headers,body:'{}'});
      expect(fitResponse.status).toBe(200);
      const emptyFit=FitResponseSchema.parse(await fitResponse.json());
      expect(emptyFit).toMatchObject({userId,feedbackRevision:0,trainedExamples:0,metrics:{labeledExamples:0}});
      expect(emptyFit.metrics).toEqual(await ml.client.evaluation({userId}));
      const [receipt]=await db.transaction(tx=>tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`);
      expect(receipt).toMatchObject({model_version:emptyFit.modelVersion,feedback_revision:0});

      const queue=async()=>{
        const response=await fetch(`${base}/api/queue?limit=1`,{headers});
        expect(response.status).toBe(200);
        const result=QueueResultSchema.parse(await response.json());
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.track.isPlayable).toBe(true);
        expect(result.items[0]!.track.trackId).not.toBe(provider.unplayableId);
        return result;
      };
      const publication=async(item:Item)=>{
        const [row]=await db.transaction(tx=>tx`
          SELECT i.draft,i.publication,b.published,b.closed_at FROM policy_exposure_bindings b
          JOIN policy_selection_intents i USING(user_id,request_id)
          WHERE b.user_id=${userId} AND b.exposure_id=${item.exposure.exposureId}`);
        expect(row?.published).toBe(true);expect(row?.closed_at).toBeNull();
        return row as {draft:SelectionDraft;publication:PublishedSelection};
      };
      const intentCount=async()=>Number((await db.transaction(tx=>tx`SELECT count(*)::integer AS n FROM policy_selection_intents WHERE user_id=${userId}`))[0]!.n);
      const associations=async():Promise<AssociationRow[]>=>db.transaction(tx=>tx`SELECT payload,receipt,completed_at,claimed_fit_receipt,disposition FROM policy_delivery_events WHERE user_id=${userId} AND kind='associate' ORDER BY sequence`);
      const diagnostics=()=>ml!.diagnostics();
      const assertScored=async(item:Item)=>{
        expect(item.exposure.modelVersion).toBe(item.prediction.modelVersion);
        const stored=await repository.getExposure(userId,item.exposure.exposureId);
        expect(stored?.prediction).toEqual(item.prediction);
        expect(stored?.features.permittedForTraining).toBe(true);
        expect(stored?.features.values.energy??null).toBeNull();
        expect((await ml!.client.explain({userId,exposureId:item.exposure.exposureId})).prediction).toEqual(item.prediction);
      };
      const assertContext=async(item:Item,counts:Map<string,number>,eventCount:number)=>{
        const stored=(await repository.getExposure(userId,item.exposure.exposureId))!;
        expect(stored.listeningContext).toMatchObject({source:'spotify-recently-played',completeHistory:false,sampleLimit:50,
          status:'fresh',cachedEventCount:eventCount,uniqueEventCount:eventCount,windowEventCount:eventCount});
        expect(stored.listeningContext?.ageMs).toBeGreaterThanOrEqual(0);
        if(counts.has(item.track.trackId))expect(stored.features.values.recent_play_count).toBe(counts.get(item.track.trackId)!);
        else expect(Object.hasOwn(stored.features.values,'recent_play_count')).toBe(false);
        return stored;
      };
      const assertAdaptive=async(item:Item,method:Strategy,rewards:number)=>{
        const stored=await publication(item);
        expect(stored.draft.kind).toBe('adaptive');
        if(stored.draft.kind!=='adaptive')throw new Error('Adaptive selection lost its durable binding');
        const inspection=await ml!.exposure(item.exposure.exposureId),decision=inspection.decision;
        expect(stored.publication.policyDecision).toEqual(decision);
        expect(decision.config.strategy).toBe(strategy);
        expect(decision.modelVersion).toBe(stored.draft.request.modelVersion);
        expect(decision.feedbackRevision).toBe(stored.draft.request.feedbackRevision);
        expect(stored.draft.listeningContext).toEqual((await repository.getExposure(userId,item.exposure.exposureId))!.listeningContext!);
        for(const candidate of stored.draft.request.candidates){
          if(provider.initialCounts.has(candidate.trackId))expect(candidate.features.values.recent_play_count).toBe(provider.initialCounts.get(candidate.trackId)!);
          else expect(Object.hasOwn(candidate.features.values,'recent_play_count')).toBe(false);
        }
        expect(decision.trackId).toBe(item.track.trackId);
        expect(decision.prediction).toEqual(item.prediction);
        expect(decision.candidate.features).toEqual((await repository.getExposure(userId,item.exposure.exposureId))!.features);
        expect(item.exposure.policyVersion).toBe(decision.policyVersion);
        expect(item.exposure.uncertainty).toBe(decision.prediction.uncertainty);
        expect(item.exposure.policyTelemetry).toMatchObject({
          selectionMethod:method,policyStateVersion:decision.policyStateVersion,
          contextVersion:decision.contextVersion,rewardVersion:decision.rewardVersion,
          modelFeedbackRevision:decision.feedbackRevision,trainedRewards:rewards,
          predictedReward:decision.selection.predictedReward,selectionScore:decision.selection.selectionScore,
          uncertainty:decision.selection.uncertainty,explorationBonus:decision.selection.explorationBonus,
          informationGain:decision.selection.informationGain,
        });
        expect(inspection.reservation.status).toBe('active');
        expect(decision.candidateTrackIds).not.toContain(provider.unplayableId);
      };
      const awaitDecision=async(id:string,status:'COMPLETE'|'UNDONE')=>{
        let result:ReviewResult|undefined;
        await eventually(`decision ${status}`,async()=>{
          const history=DecisionHistorySchema.parse(await(await fetch(`${base}/api/decisions/history`,{headers})).json());
          result=history.items.find(row=>row.decisionId===id);
          if(result?.status==='FAILED_TERMINAL')throw new Error(`Controlled decision failed: ${result.error?.code}`);
          return result?.status===status;
        });
        return result!;
      };
      const awaitFeedback=async(revision:number,labels:number)=>{
        await eventually('C1 fit and persisted feedback acknowledgement',async()=>{
          const [job]=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);
          return Number(job?.acknowledged_revision)===revision;
        });
        const metrics=await ml!.client.evaluation({userId});
        expect(metrics.labeledExamples).toBe(labels);
        const insights=ModelInsightsSchema.parse(await(await fetch(`${base}/api/ml/insights`,{headers})).json());
        expect(insights.metrics).toEqual(metrics);
        const [current]=await db.transaction(tx=>tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`);
        expect(current).toMatchObject({model_version:metrics.modelVersion,feedback_revision:revision});
      };
      const awaitAssociations=async(count:number,rewards:number)=>{
        if(strategy!=='c1')await eventually('committed policy association delivery',async()=>{
          const rows=await associations();
          return rows.length===count&&rows.every(row=>row.completed_at!==null);
        });
        const rows=await associations();
        expect(rows).toHaveLength(strategy==='c1'?0:count);
        for(const row of rows){
          const event=PolicyAssociationEventSchema.parse(row.payload),ack=PolicyAssociationReceiptSchema.parse(row.receipt);
          expect(row.disposition).toBe('acknowledged');
          expect(ack.eventId).toBe(event.eventId);expect(ack.sequence).toBe(event.sequence);
          expect(ack.fitReceipt).toEqual(row.claimed_fit_receipt!);
          expect(ack.fitReceipt.synchronizedFeedbackRevision).toBeGreaterThanOrEqual(event.feedbackRevision);
          expect(event.source).toBe('cleanup');
        }
        const observed=await diagnostics();
        expect(observed.counts.activeRewards).toBe(strategy==='c1'?0:rewards);
        expect(observed.counts.feedbackEvents).toBe(strategy==='c1'?0:count);
        return rows;
      };
      const act=async(item:Item,action:'KEEP'|'SKIP')=>{
        const body=JSON.stringify({trackId:item.track.trackId,exposureId:item.exposure.exposureId,action,idempotencyKey:crypto.randomUUID()});
        const response=await fetch(`${base}/api/decisions`,{method:'POST',headers,body});
        expect(response.status).toBe(202);
        const pending=ReviewResultSchema.parse(await response.json());
        return {body,complete:await awaitDecision(pending.decisionId,'COMPLETE')};
      };

      const initial=await queue(),first=initial.items[0]!;
      expect(initial.remaining).toBe(provider.tracks.length-1);
      await assertScored(first);
      const firstFrozen=await assertContext(first,provider.initialCounts,4);
      expect(first.prediction.modelVersion).toBe(emptyFit.modelVersion);
      if(strategy==='c1'){
        expect((await publication(first)).draft.kind).toBe('c1');
        expect(first.exposure.policyTelemetry).toBeUndefined();
      }else await assertAdaptive(first,'c1',0); // Cold policy genuinely binds its C1-selected exposure.
      const beforeReplay=await intentCount(),selectsBefore=ml.selectIds.length;
      expect((await queue()).items).toEqual(initial.items);
      expect(await intentCount()).toBe(beforeReplay);expect(ml.selectIds).toHaveLength(selectsBefore);

      const keep=await act(first,'KEEP');
      expect(keep.complete.label).toBe(0);
      await awaitFeedback(keep.complete.feedbackRevision,1);
      const training=await repository.trainingExamples(userId);
      expect(training.examples).toHaveLength(1);
      expect(training.examples[0]).toMatchObject({decisionId:keep.complete.decisionId,trackId:first.track.trackId,label:0,split:'train'});
      const firstEvents=await awaitAssociations(1,1);
      if(strategy!=='c1'){
        expect(firstEvents[0]!.receipt!.eligibleForLearning).toBe(true);
        expect(firstEvents[0]!.payload).toMatchObject({operation:'upsert',exposureId:first.exposure.exposureId,decisionId:keep.complete.decisionId,modelVersion:first.prediction.modelVersion});
        expect(firstEvents[0]!.claimed_fit_receipt!.modelVersion).toBe((await ml.client.evaluation({userId})).modelVersion);
      }
      const repeat=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:keep.body});
      expect(repeat.status).toBe(200);
      expect(ReviewResultSchema.parse(await repeat.json()).decisionId).toBe(keep.complete.decisionId);
      await awaitAssociations(1,1);

      const second=(await queue()).items[0]!;
      expect(second.track.trackId).not.toBe(first.track.trackId); // Committed strong feedback excludes every policy.
      await assertScored(second);
      await assertContext(second,provider.initialCounts,4);
      if(strategy!=='c1')await assertAdaptive(second,strategy,1);
      const skip=await act(second,'SKIP');
      expect(skip.complete.label).toBeNull();
      expect(skip.complete.feedbackRevision).toBe(keep.complete.feedbackRevision);
      const skipped=await awaitAssociations(2,1);
      if(strategy!=='c1'){
        expect(skipped[1]!.payload).toMatchObject({operation:'upsert',label:null,decisionId:skip.complete.decisionId});
        expect(skipped[1]!.receipt!.eligibleForLearning).toBe(false);
        expect((await ml.exposure(second.exposure.exposureId)).reservation.closureReason).toBe('skip');
      }

      // Replace only our authored owner's cache. Old prediction/training evidence must stay frozen.
      const replacementCounts=new Map([...provider.initialCounts].map(([id,count])=>[id,count+1]));
      const replacementAt=new Date().toISOString();
      const replacementEvents=[...replacementCounts].flatMap(([trackId,count])=>Array.from({length:count},(_,index)=>({
        trackId,playedAt:new Date(Date.parse(replacementAt)-(index+1)*60_000).toISOString(),
      })));
      await a1Store.transaction(tx=>tx.putTasteContext({userId,source:'spotify-recently-played',completeHistory:false,
        fetchedAt:replacementAt,error:null,events:replacementEvents}));
      expect((await repository.trainingExamples(userId)).examples[0]?.features).toEqual(firstFrozen.features);
      expect(await repository.getExposure(userId,first.exposure.exposureId)).toEqual(firstFrozen);

      const undoBody=JSON.stringify({idempotencyKey:crypto.randomUUID()}),undoUrl=`${base}/api/decisions/${keep.complete.decisionId}/undo`;
      const undo=await fetch(undoUrl,{method:'POST',headers,body:undoBody});
      expect(undo.status).toBe(409);expect((await undo.json() as {code:string}).code).toBe('UNDO_PENDING');
      const undone=await awaitDecision(keep.complete.decisionId,'UNDONE');
      expect(undone.labelState).toBe('revoked');
      await awaitFeedback(undone.feedbackRevision,0);
      const revoked=await awaitAssociations(3,0);
      if(strategy!=='c1'){
        expect(revoked[2]!.payload).toMatchObject({operation:'revoke',label:null,decisionId:keep.complete.decisionId,exposureId:first.exposure.exposureId});
        expect(revoked[2]!.receipt!.eligibleForLearning).toBe(false);
        expect((await ml.exposure(first.exposure.exposureId)).feedback.every(row=>row.eligibleForLearning===false)).toBe(true);
      }
      expect((await fetch(undoUrl,{method:'POST',headers,body:undoBody})).status).toBe(200);
      await awaitAssociations(3,0);
      await assertScored(first); // Original prediction remains immutable through later fits and Undo.
      expect(await repository.getExposure(userId,first.exposure.exposureId)).toEqual(firstFrozen);

      const calibrationResponse=await fetch(`${base}/api/calibration/queue?limit=12`,{headers});
      expect(calibrationResponse.status).toBe(200);
      const calibrationItems=CalibrationQueueResultSchema.parse(await calibrationResponse.json()).items;
      expect(calibrationItems.some(item=>!replacementCounts.has(item.track.trackId))).toBe(true);
      for(const item of calibrationItems)await assertContext(item,replacementCounts,7);
      const calibration=calibrationItems.find(item=>replacementCounts.has(item.track.trackId))!;
      expect(calibration).toBeDefined();
      const labelResponse=await fetch(`${base}/api/calibration/labels`,{method:'POST',headers,body:JSON.stringify({
        trackId:calibration.track.trackId,exposureId:calibration.exposure.exposureId,label:1,idempotencyKey:crypto.randomUUID(),
      })});
      expect(labelResponse.status).toBe(200);
      const label=CalibrationLabelResultSchema.parse(await labelResponse.json());
      await awaitFeedback(label.feedbackRevision,1);
      expect((await repository.trainingExamples(userId)).examples[0]).toMatchObject({trackId:calibration.track.trackId,label:1,split:'train'});
      expect((await repository.trainingExamples(userId)).examples[0]?.features).toEqual((await repository.getExposure(userId,calibration.exposure.exposureId))?.features);
      await awaitAssociations(3,0);
      expect((await associations()).some(row=>row.payload.exposureId===calibration.exposure.exposureId)).toBe(false);

      // Fail only policy selection: actual C1 scoring/fit/inspection remain reachable.
      await db.transaction(tx=>tx`DELETE FROM taste_context WHERE user_id=${userId}`);
      ml.failPolicySelect();
      const fallback=await queue(),fallbackItem=fallback.items[0]!;
      expect(fallbackItem.track.trackId).not.toBe(calibration.track.trackId);
      expect(fallbackItem.exposure.policyTelemetry).toBeUndefined();
      expect((await publication(fallbackItem)).draft.kind).toBe('c1');
      expect((await publication(fallbackItem)).publication.policyDecision).toBeNull();
      await assertScored(fallbackItem);
      const withoutCache=(await repository.getExposure(userId,fallbackItem.exposure.exposureId))!;
      expect(withoutCache.listeningContext).toMatchObject({status:'missing',fetchedAt:null,cachedEventCount:null,uniqueEventCount:null,windowEventCount:null});
      expect(Object.hasOwn(withoutCache.features.values,'recent_play_count')).toBe(false);
      expect(await repository.getExposure(userId,first.exposure.exposureId)).toEqual(firstFrozen);
      if(strategy!=='c1'){
        expect(fallbackItem.exposure.policyVersion).toBe(`queue:c1-fallback:${strategy}:v1`);
        expect(fallback.fallbackReason).toContain('using C1');
        expect(ml.failedSelectIds).toHaveLength(1);
        expect(fallbackItem.exposure.exposureId).not.toBe(ml.failedSelectIds[0]);
        const [abandoned]=await db.transaction(tx=>tx`SELECT published,closed_at,closure_reason FROM policy_exposure_bindings WHERE exposure_id=${ml!.failedSelectIds[0]!}`);
        expect(abandoned?.published).toBe(false);expect(abandoned?.closed_at).not.toBeNull();expect(abandoned?.closure_reason).toBe('abandoned');
      }else expect(ml.selectIds).toHaveLength(0);
      expect((await queue()).items).toEqual(fallback.items);
      // This C1 fallback decision must never retrospectively acquire policy reward attribution.
      const fallbackSkip=await act(fallbackItem,'SKIP');
      expect(fallbackSkip.complete.label).toBeNull();
      await awaitAssociations(3,0);
      expect(provider.writes).toEqual([]); // All tested cleanup/calibration operations are nonmutating Spotify actions.

      if(strategy==='c1'){
        // Real schema capability checks. Close all workers before changing this isolated schema.
        await runtime.close();
        await db.transaction(tx=>tx.unsafe(`ALTER TABLE "${db.schema}".policy_delivery_events RENAME TO unavailable_policy_delivery_events`));
        runtime=await makeRuntime({C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:'linucb'});
        expect(runtime.startupIssues).toContain('POLICY_DATABASE_UNAVAILABLE');
        const partialBase=await runtime.app.listen({host:'127.0.0.1',port:0});
        const blocked=await fetch(`${partialBase}/api/queue?limit=1`,{headers});
        expect(blocked.status).toBe(503);expect((await blocked.json() as {code:string}).code).toBe('POLICY_STORAGE_UNAVAILABLE');
        expect((await fetch(`${partialBase}/api/calibration/queue?limit=1`,{headers})).status).toBe(200);
        expect((await fetch(`${partialBase}/api/ml/retrain`,{method:'POST',headers,body:'{}'})).status).toBe(200);
        expect((await(await fetch(`${partialBase}/api/health`)).json() as {capabilities:{database:boolean}}).capabilities.database).toBe(true);
        await runtime.close();
        await db.transaction(tx=>tx.unsafe(`ALTER TABLE "${db.schema}".unavailable_policy_delivery_events RENAME TO policy_delivery_events`));
        await db.transaction(async tx=>{
          const tables=['policy_delivery_events','policy_release_commands','policy_exposure_bindings','policy_selection_intents','policy_fit_receipts','policy_owner_state'];
          await tx.unsafe(`DROP TABLE ${tables.map(table=>`"${db.schema}"."${table}"`).join(',')} CASCADE`);
          await tx`DELETE FROM schema_migrations WHERE name='016_policy.sql'`;
        });
        runtime=await makeRuntime({C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:'linucb'});
        expect(runtime.startupIssues).toContain('POLICY_DATABASE_UNAVAILABLE');
        const legacyBase=await runtime.app.listen({host:'127.0.0.1',port:0});
        const legacyResponse=await fetch(`${legacyBase}/api/queue?limit=1`,{headers});
        expect(legacyResponse.status).toBe(200);
        const legacy=QueueResultSchema.parse(await legacyResponse.json());
        expect(legacy.items).toHaveLength(1);expect(legacy.items[0]!.exposure.policyTelemetry).toBeUndefined();
        expect(['deterministic_baseline','logistic_rank']).toContain(legacy.items[0]!.exposure.selectionMethod);
        expect((await fetch(`${legacyBase}/api/ml/retrain`,{method:'POST',headers,body:'{}'})).status).toBe(200);
        expect(ml.selectIds).toHaveLength(0);
      }
    } finally {
      // Independent cleanup steps still run if one fails; only our unique test schema is dropped.
      const cleanupErrors:unknown[]=[];
      for(const close of [()=>runtime?.close(),()=>db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`),()=>db.close(),()=>ml?.close()]){
        try{await close();}catch(error){cleanupErrors.push(error);}
      }
      if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Controlled policy smoke cleanup failed');
    }
  },180_000,
);

test.skipIf(!databaseUrl)('lifecycle: real backend/ML expiry, restart, release and permanent sealed exclusions',async()=>{
  const db=new Database(databaseUrl!,`test_policy_lifecycle_${crypto.randomUUID().replaceAll('-','')}`);
  const repository=new Repository(db),policyStore=new PostgresPolicyStore(db),provider=controlledSpotify();
  let runtime:Runtime|undefined,ml:Awaited<ReturnType<typeof localMl>>|undefined;
  try{
    await migrate(db);
    ml=await localMl({reservationTtlSeconds:30});
    const startRuntime=async()=>{
      runtime=await buildRuntime({env:{
        NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:db.schema,
        ML_SERVICE_URL:ml!.serviceUrl,ML_SERVICE_SHARED_SECRET:ml!.sharedSecret,
        METADATA_RIGHTS_BASIS:'Authored lifecycle fixtures; no real account or efficacy claim',
        SPOTIFY_CLIENT_ID:'controlled-client',SPOTIFY_ALLOWED_USER_IDS:owner,
        TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),
        SESSION_SECRET:'controlled-policy-test-only-'.repeat(3),
        C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:'epsilon_greedy',
      },spotifyHttp:new SpotifyHttp({fetch:provider.fetch}),spotifyMutationFetch:provider.fetch});
      expect(runtime.startupIssues).toEqual([]);
      return runtime.app.listen({host:'127.0.0.1',port:0});
    };
    let base=await startRuntime();
    const cookie=await login(base),headers={cookie,origin,'content-type':'application/json'};
    expect((await fetch(`${base}/api/library/sync`,{method:'POST',headers,body:'{}'})).status).toBe(202);
    await eventually('lifecycle fixture import',async()=>{
      const status=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers})).json());
      if(status.status==='failed')throw new Error('Lifecycle fixture import failed');
      return status.status==='complete'&&status.processed===provider.tracks.length;
    });

    // This is a permanent-reservation fixture, not a second test of Batch2 sampling.
    // Actual HTTP calibration creates the immutable feature/exposure rows first.
    const calibrationResponse=await fetch(`${base}/api/calibration/queue?limit=100`,{headers});
    expect(calibrationResponse.status).toBe(200);
    const calibration=CalibrationQueueResultSchema.parse(await calibrationResponse.json()).items;
    expect(calibration).toHaveLength(provider.tracks.length-1);
    const eligible=calibration[0]!,sealed=calibration.slice(1),sealedIds=sealed.map(item=>item.track.trackId);
    const batchId=crypto.randomUUID(),itemIds=sealed.map(()=>crypto.randomUUID()),selectedAt=new Date().toISOString();
    const frozenCandidates=await Promise.all(sealed.map(async item=>{
      const stored=(await repository.getExposure(userId,item.exposure.exposureId))!;
      return {track:item.track,features:stored.features,prediction:stored.prediction,
        ...(stored.listeningContext?{listeningContext:stored.listeningContext}:{})};
    }));
    await db.transaction(async tx=>{
      await tx`INSERT INTO calibration_batches(batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot)
        VALUES(${batchId},${userId},'calibration-batch2-v1',42,'authored-lifecycle-fixture',${sealed[0]!.prediction.modelVersion},${selectedAt},'{}'::jsonb)`;
      for(const [index,item] of sealed.entries()){
        const status=['pending','skipped','revoked'][index%3]!;
        const replacementFor=index===sealed.length-1?itemIds[1]!:null;
        await tx`INSERT INTO calibration_batch_items(batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,status,exposure_id,replacement_for)
          VALUES(${itemIds[index]!},${userId},${batchId},${item.track.trackId},'A','sealed_evaluation','{}'::jsonb,${JSON.stringify(frozenCandidates[index])}::jsonb,${selectedAt},${index},${status},${item.exposure.exposureId},${replacementFor})`;
        await tx`INSERT INTO calibration_batch_exposures(user_id,batch_item_id,exposure_id) VALUES(${userId},${itemIds[index]!},${item.exposure.exposureId})`;
      }
    });
    const labelResponse=await fetch(`${base}/api/calibration/labels`,{method:'POST',headers,body:JSON.stringify({
      trackId:sealed[0]!.track.trackId,exposureId:sealed[0]!.exposure.exposureId,label:1,idempotencyKey:crypto.randomUUID(),
    })});
    expect(labelResponse.status).toBe(200);
    const label=CalibrationLabelResultSchema.parse(await labelResponse.json());
    await eventually('sealed calibration feedback acknowledgement',async()=>{
      const [job]=await db.transaction(tx=>tx`SELECT acknowledged_revision FROM feedback_sync_jobs WHERE user_id=${userId}`);
      return Number(job?.acknowledged_revision)===label.feedbackRevision;
    });
    const fitResponse=await fetch(`${base}/api/ml/retrain`,{method:'POST',headers,body:'{}'});
    expect(fitResponse.status).toBe(200);
    const fit=FitResponseSchema.parse(await fitResponse.json());
    expect(fit.feedbackRevision).toBe(label.feedbackRevision);
    expect(fit.trainedExamples).toBe(0);expect(fit.metrics.labeledExamples).toBe(0);expect(fit.metrics.heldOutExamples).toBe(0);
    expect((await repository.trainingExamples(userId)).examples).toEqual([]);
    const sealedSnapshot=()=>db.transaction(tx=>tx`SELECT track_id,assignment,status,exposure_id,candidate,replacement_for FROM calibration_batch_items WHERE user_id=${userId} ORDER BY position`);
    const sealedBefore=await sealedSnapshot();
    expect(new Set(sealedBefore.map((row:{status:string})=>row.status))).toEqual(new Set(['pending','labeled','skipped','revoked']));
    expect(sealedBefore.some((row:{replacement_for:string|null})=>row.replacement_for!==null)).toBe(true);
    expect((await policyStore.reviewCandidates(userId)).eligibleTrackIds).toEqual([eligible.track.trackId]);

    const queue=async()=>{
      const response=await fetch(`${base}/api/queue?limit=1`,{headers});
      expect(response.status).toBe(200);
      const result=QueueResultSchema.parse(await response.json());
      expect(result.items).toHaveLength(1);expect(result.remaining).toBe(1);
      expect(result.items[0]!.track.trackId).toBe(eligible.track.trackId);
      expect(result.items[0]!.exposure.policyTelemetry).toBeDefined();
      return result.items[0]!;
    };
    const counts=()=>db.transaction(tx=>tx`SELECT
      (SELECT count(*)::integer FROM review_decisions WHERE user_id=${userId}) AS decisions,
      (SELECT count(*)::integer FROM policy_delivery_events WHERE user_id=${userId} AND kind='associate') AS associations,
      (SELECT count(*)::integer FROM policy_selection_intents WHERE user_id=${userId}) AS intents`);
    const first=await queue(),firstId=first.exposure.exposureId;
    const firstFrozen=await repository.getExposure(userId,firstId),firstInspection=await ml.exposure(firstId);
    const firstIntent=(await policyStore.currentSelection(userId))!;
    const firstRequest=ml.selectRequests.find(request=>request.exposureId===firstId)!;
    expect(firstRequest).toBeDefined();
    expect(Date.parse(firstInspection.reservation.expiresAt)-Date.parse(firstInspection.reservation.reservedAt)).toBe(30_000);
    expect(firstInspection.decision.feedbackRevision).toBe(fit.feedbackRevision);
    expect(firstInspection.decision.modelVersion).toBe(fit.modelVersion);
    expect(firstInspection.decision.candidateTrackIds).toEqual([eligible.track.trackId]);
    expect(await counts()).toEqual([{decisions:0,associations:0,intents:1}]);

    // Persisted session and artifacts survive a new Fastify runtime and real ML process restart.
    await runtime!.close();runtime=undefined;
    await ml.restart();base=await startRuntime();
    expect(await queue()).toEqual(first);
    expect(await counts()).toEqual([{decisions:0,associations:0,intents:1}]);
    expect(ml.selectIds).toEqual([firstId]);
    const restarted=await ml.exposure(firstId),restartedIntent=(await policyStore.currentSelection(userId))!;
    expect(restarted.decision).toEqual(firstInspection.decision);
    expect(restarted.reservation.expiresAt).toBe(firstInspection.reservation.expiresAt);
    expect(restartedIntent.expiresAt).toBe(firstIntent.expiresAt);
    expect(restartedIntent.publication!.reservations).toEqual(firstIntent.publication!.reservations);
    expect(await ml.policy.select(firstRequest)).toEqual(firstInspection.decision);

    // Actual ML server-clock expiry; no test clock or UPDATE shortens either lease.
    await eventually('actual thirty-second policy expiry',async()=>
      (await ml!.exposure(firstId)).reservation.status==='expired',40_000);
    const rejected=await fetch(`${base}/api/decisions`,{method:'POST',headers,body:JSON.stringify({
      trackId:first.track.trackId,exposureId:firstId,action:'KEEP',idempotencyKey:crypto.randomUUID(),
    })});
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({code:'POLICY_EXPOSURE_CLOSED',retryable:false});
    expect(await counts()).toEqual([{decisions:0,associations:0,intents:1}]);
    expect(await ml.policy.select(firstRequest)).toEqual(firstInspection.decision);
    const expired=await ml.exposure(firstId);
    expect(expired.reservation.status).toBe('expired');
    expect(expired.reservation.closedAt).toBe(firstInspection.reservation.expiresAt);

    const second=await queue(),secondId=second.exposure.exposureId;
    expect(secondId).not.toBe(firstId);
    expect((await policyStore.currentSelection(userId))!.requestId).not.toBe(firstIntent.requestId);
    const [expiredBinding]=await db.transaction(tx=>tx`SELECT closed_at,expires_at,closure_reason FROM policy_exposure_bindings WHERE exposure_id=${firstId}`);
    expect(expiredBinding.closed_at).toEqual(expiredBinding.expires_at);expect(expiredBinding.closure_reason).toBe('expiry');
    expect(await repository.getExposure(userId,firstId)).toEqual(firstFrozen);

    const secondIntent=(await policyStore.currentSelection(userId))!;
    const release={userId,requestId:secondIntent.requestId,releaseId:crypto.randomUUID(),exposureIds:[secondId],reason:'prefetch_discarded' as const};
    const releaseResult=await policyStore.releaseSelection(release);
    expect(await policyStore.releaseSelection(release)).toEqual(releaseResult);
    await eventually('database release delivered to real ML',async()=>{
      const [event]=await db.transaction(tx=>tx`SELECT completed_at FROM policy_delivery_events WHERE user_id=${userId} AND exposure_id=${secondId} AND kind='release'`);
      return event?.completed_at!==null&&event?.completed_at!==undefined;
    });
    const [releaseEvent]=await db.transaction(tx=>tx`SELECT payload,receipt,disposition FROM policy_delivery_events WHERE user_id=${userId} AND exposure_id=${secondId} AND kind='release'`);
    const releaseReceipt=PolicyReleaseReceiptSchema.parse(releaseEvent.receipt);
    expect(releaseEvent.disposition).toBe('acknowledged');expect(releaseReceipt.outcome).toBe('released');
    expect(releaseReceipt.exposureId).toBe(secondId);expect(releaseReceipt.trackId).toBe(second.track.trackId);
    expect(await ml.policy.release(releaseEvent.payload)).toEqual(releaseReceipt);
    const released=await ml.exposure(secondId);
    expect(released.reservation.status).toBe('released');expect(released.reservation.closureReason).toBe('explicit_release');

    await runtime!.close();runtime=undefined;
    await ml.restart();base=await startRuntime();
    expect(await policyStore.releaseSelection(release)).toEqual(releaseResult);
    expect(await ml.policy.release(releaseEvent.payload)).toEqual(releaseReceipt);
    const third=await queue();
    expect([firstId,secondId]).not.toContain(third.exposure.exposureId);
    expect(await ml.policy.release(releaseEvent.payload)).toEqual(releaseReceipt);
    expect((await ml.exposure(third.exposure.exposureId)).reservation.status).toBe('active');
    expect((await ml.exposure(firstId)).decision).toEqual(firstInspection.decision);
    expect((await ml.exposure(firstId)).reservation).toMatchObject({status:'expired',closedAt:expired.reservation.closedAt,expiresAt:expired.reservation.expiresAt});
    expect(await repository.getExposure(userId,firstId)).toEqual(firstFrozen);
    expect(await sealedSnapshot()).toEqual(sealedBefore);
    for(const request of ml.selectRequests){
      expect(request.candidates.map(candidate=>candidate.trackId)).toEqual([eligible.track.trackId]);
      expect(request.candidates.some(candidate=>sealedIds.includes(candidate.trackId))).toBe(false);
    }
    expect((await repository.trainingExamples(userId)).examples).toEqual([]);
    expect((await ml.client.evaluation({userId})).labeledExamples).toBe(0);
    expect((await ml.diagnostics()).counts).toMatchObject({activeRewards:0,feedbackEvents:0});
    expect(await counts()).toEqual([{decisions:0,associations:0,intents:3}]);
    expect(provider.writes).toEqual([]);
  }finally{
    const cleanupErrors:unknown[]=[];
    for(const close of [()=>runtime?.close(),()=>db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`),()=>db.close(),()=>ml?.close()]){
      try{await close();}catch(error){cleanupErrors.push(error);}
    }
    if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Controlled lifecycle smoke cleanup failed');
  }
},180_000);

async function eventually(name:string,check:()=>Promise<boolean>,timeoutMs=25_000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){if(await check())return;await Bun.sleep(100);}
  throw new Error(`Timed out waiting for ${name}`);
}

async function login(base:string){
  const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});
  expect(start.status).toBe(302);
  const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
  const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state,code:'controlled-code'})}`,{
    headers:{cookie:start.headers.get('set-cookie')!.split(';')[0]!},redirect:'manual',
  });
  expect(callback.status).toBe(302);
  const cookie=callback.headers.getSetCookie().find(value=>value.startsWith('sortfm_session='))!.split(';')[0]!;
  const session=AccountSessionSchema.parse(await(await fetch(`${base}/api/me`,{headers:{cookie}})).json());
  expect(session.user?.id).toBe(userId);expect(session.mode).toBe('spotify');
  return cookie;
}

function controlledSpotify(){
  const trainIds:string[]=[];
  for(let n=1;trainIds.length<12;n++){
    const id=String(n).padStart(22,'0');if(feedbackSplit(userId,id)==='train')trainIds.push(id);
  }
  const unplayableId='9999999999999999999999';
  const tracks=[...trainIds,unplayableId].map((id,index)=>({added_at:'2020-01-01T00:00:00Z',track:{
    id,name:`Authored policy fixture ${index}`,duration_ms:120000+index*1000,is_playable:id!==unplayableId,
    artists:[{id:`controlled-artist-${index}`,name:`Authored artist ${index}`}],
    album:{name:'Authored album',release_date:'2019-01-01',images:[]},
  }}));
  const writes:string[]=[];
  const initialCounts=new Map([[trainIds[0]!,2],[trainIds[1]!,1],[trainIds[2]!,1]]);
  const sampleAt=Date.now();
  const recentEvents=[...initialCounts].flatMap(([id,count])=>Array.from({length:count},(_,index)=>({
    track:{id},played_at:new Date(sampleAt-(index+1)*60_000).toISOString(),
  })));
  return {tracks,unplayableId,writes,initialCounts,fetch:async(url:string,init?:RequestInit)=>{
    const parsed=new URL(url),method=init?.method??'GET';
    if(parsed.pathname==='/api/token'&&method==='POST')return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-read-recently-played user-library-modify playlist-modify-private playlist-read-private'});
    if(parsed.pathname==='/v1/me'&&method==='GET')return Response.json({id:owner,display_name:'Authored test account',images:[]});
    if(parsed.pathname==='/v1/me/player/recently-played'&&method==='GET')return Response.json({items:[...recentEvents,recentEvents[0]!]});
    if(parsed.pathname==='/v1/me/tracks'&&method==='GET')return Response.json({offset:0,limit:50,total:tracks.length,next:null,items:tracks});
    if(parsed.pathname==='/v1/me/library/contains'&&method==='GET')return Response.json([true]);
    if(method!=='GET')writes.push(`${method}:${parsed.pathname}`);
    throw new Error('Unexpected controlled Spotify transport request');
  }};
}

async function localMl(options:{reservationTtlSeconds?:number}={}){
  const artifactDir=await mkdtemp(join(tmpdir(),'sortfm-policy-backend-ml-'));
  const reservation=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')});
  const port=reservation.port!;await reservation.stop(true);
  const directUrl=`http://127.0.0.1:${port}`,sharedSecret=crypto.randomUUID();
  const spawn=()=>Bun.spawn(['uv','run','--locked','--directory',fileURLToPath(new URL('../../../services/ml',import.meta.url)),
    'uvicorn','sortfm_ml.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{
    env:{...process.env,ML_SERVICE_SHARED_SECRET:sharedSecret,ML_ARTIFACT_DIR:artifactDir,
      ...(options.reservationTtlSeconds===undefined?{}:{ML_POLICY_RESERVATION_TTL_SECONDS:String(options.reservationTtlSeconds)})},stdout:'ignore',stderr:'ignore',
  });
  let worker=spawn();
  let failSelect=false;
  const selectIds:string[]=[],failedSelectIds:string[]=[],selectRequests:PolicySelectRequest[]=[];
  const proxy=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/policy/select'){
      const payload=PolicySelectRequestSchema.parse(await request.clone().json()),id=payload.exposureId;
      selectRequests.push(payload);
      selectIds.push(id);
      if(failSelect){failedSelectIds.push(id);return Response.json({code:'POLICY_STATE_UNAVAILABLE',message:'Controlled policy outage',retryable:true},{status:503});}
    }
    return fetch(new Request(`${directUrl}${url.pathname}${url.search}`,request));
  }});
  const close=async()=>{
    try{await proxy.stop(true);}finally{
      try{if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;}
      finally{await rm(artifactDir,{recursive:true,force:true});}
    }
  };
  const ready=async()=>{
    await eventually('isolated ML readiness',async()=>{
      if(worker.exitCode!==null)throw new Error('Controlled ML process exited before readiness');
      return Boolean((await fetch(`${directUrl}/health`,{signal:AbortSignal.timeout(1000)}).catch(()=>null))?.ok);
    });
  };
  const restart=async()=>{
    if(worker.exitCode===null)worker.kill('SIGTERM');await worker.exited;
    worker=spawn();await ready();
  };
  try{
    await ready();
    const serviceUrl=`http://127.0.0.1:${proxy.port}`,headers={authorization:`Bearer ${sharedSecret}`};
    return {serviceUrl,sharedSecret,selectIds,failedSelectIds,selectRequests,close,restart,failPolicySelect:()=>{failSelect=true;},
      client:createMlClient({serviceUrl:directUrl,sharedSecret}),
      policy:createPolicyClient({serviceUrl:directUrl,sharedSecret}),
      diagnostics:async()=>PolicyDiagnosticsSchema.parse(await(await fetch(`${directUrl}/policy/diagnostics?${new URLSearchParams({userId})}`,{headers})).json()),
      exposure:async(exposureId:string)=>PolicyExposureSchema.parse(await(await fetch(`${directUrl}/policy/exposure?${new URLSearchParams({userId,exposureId})}`,{headers})).json()),
    };
  }catch(error){await close();throw error;}
}
