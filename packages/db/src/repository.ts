import {
 TrackInputSchema,SavedTrackInputSchema,ExposureInputSchema,DecisionInputSchema,UndoCommandInputSchema,ReviewResultSchema,MutationTransitionInputSchema,
 ModelRunInputSchema,ImportProgressInputSchema,TelemetryInputSchema,FEATURE_VERSION,AccountSessionSchema,
 type TrackInput,type SavedTrackInput,type TrackCard,type ExposureInput,type DecisionInput,type UndoCommandInput,type ReviewResult,
 type MutationTransitionInput,type ModelRunInput,type ImportProgressInput,type TelemetryInput,type FeatureVector,type TrainingExampleSchema,
} from '@sortfm/contracts';
import type {z} from 'zod';
import {Database,PersistenceError,json,type Transaction} from './client';
const fail=(code:string):never=>{throw new PersistenceError(code);};
const iso=(v:Date|string)=>new Date(v).toISOString();
export async function upsertSavedTracks(tx:Transaction,inputs:SavedTrackInput[]) {
 const rows=inputs.map(v=>SavedTrackInputSchema.parse(v));if(!rows.length)return;
 await tx`INSERT INTO tracks(track_id,card,fetched_at)
  SELECT DISTINCT ON (v->'track'->>'trackId') v->'track'->>'trackId',v->'track',(v->>'syncedAt')::timestamptz
  FROM jsonb_array_elements(${json(rows)}::jsonb) v ORDER BY v->'track'->>'trackId',(v->>'syncedAt')::timestamptz DESC
  ON CONFLICT(track_id) DO UPDATE SET card=excluded.card,fetched_at=excluded.fetched_at WHERE tracks.fetched_at<=excluded.fetched_at`;
 await tx`INSERT INTO saved_tracks(user_id,track_id,original_added_at,synced_at,current_status)
  SELECT DISTINCT ON(v->>'userId',v->'track'->>'trackId') v->>'userId',v->'track'->>'trackId',(v->>'originalAddedAt')::timestamptz,(v->>'syncedAt')::timestamptz,v->>'currentStatus'
  FROM jsonb_array_elements(${json(rows)}::jsonb) WITH ORDINALITY AS items(v,n) ORDER BY v->>'userId',v->'track'->>'trackId',n
  ON CONFLICT(user_id,track_id) DO UPDATE SET synced_at=GREATEST(saved_tracks.synced_at,excluded.synced_at)`;
}

async function upsertTrack(tx:Transaction,input:TrackInput){const v=TrackInputSchema.parse(input);await tx`INSERT INTO tracks(track_id,card,fetched_at) VALUES(${v.track.trackId},${json(v.track)}::jsonb,${v.fetchedAt}) ON CONFLICT(track_id) DO UPDATE SET card=excluded.card,fetched_at=excluded.fetched_at WHERE tracks.fetched_at<=excluded.fetched_at`;}
async function lockUser(tx:Transaction,userId:string){const [user]=await tx`SELECT feedback_revision FROM users WHERE id=${userId} FOR UPDATE`;return user??fail('USER_NOT_FOUND');}
async function telemetry(tx:Transaction,v:TelemetryInput,context:Record<string,unknown>={}){
 const payload={...v,context};
 const rows=await tx`INSERT INTO interaction_events(event_id,user_id,event_type,payload,occurred_at) VALUES(${v.eventId},${v.userId},${v.eventType},${json(payload)}::jsonb,${v.occurredAt}) ON CONFLICT DO NOTHING RETURNING event_id`;
 if(!rows.length){const [same]=await tx`SELECT 1 FROM interaction_events WHERE event_id=${v.eventId} AND user_id=${v.userId} AND payload=${json(payload)}::jsonb`;if(!same)fail('EVENT_CONFLICT');return;}
 await tx`INSERT INTO ml_telemetry(event_id,user_id,model_version,event_type,prediction_score,uncertainty,processing_latency_ms,occurred_at,context) VALUES(${v.eventId},${v.userId},${v.modelVersion},${v.eventType},${v.predictionScore},${v.uncertainty},${v.processingLatencyMs},${v.occurredAt},${json(context)}::jsonb)`;
}
export class Repository {
 constructor(readonly db:Database){}
 async upsertUser(profile:NonNullable<z.infer<typeof AccountSessionSchema>['user']>,authorized=false){
  const p=AccountSessionSchema.shape.user.unwrap().parse(profile);
  await this.db.transaction(async tx=>{const rows=await tx`INSERT INTO users(id,spotify_user_id,profile,is_authorized) VALUES(${p.id},${p.spotifyId},${json(p)}::jsonb,${authorized}) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,is_authorized=excluded.is_authorized WHERE users.spotify_user_id IS NOT DISTINCT FROM excluded.spotify_user_id RETURNING id`;if(!rows.length)fail('ACCOUNT_IDENTITY_CONFLICT');});
 }
 upsertTrack(v:TrackInput){return this.db.transaction(tx=>upsertTrack(tx,v));}
 upsertSavedTracks(v:SavedTrackInput[]){return this.db.transaction(tx=>upsertSavedTracks(tx,v));}
 async library(userId:string,includeHistory=false):Promise<{track:TrackCard;currentStatus:SavedTrackInput['currentStatus'];audioFeatures:FeatureVector|null;currentDecision:ReviewResult|null}[]>{
  return this.db.transaction(async tx=>(await tx`SELECT t.card,s.original_added_at,s.current_status,a.normalized,d.result AS current_decision FROM saved_tracks s JOIN tracks t USING(track_id) LEFT JOIN current_decisions c ON c.user_id=s.user_id AND c.track_id=s.track_id LEFT JOIN review_decisions d ON d.user_id=c.user_id AND d.decision_id=c.decision_id LEFT JOIN audio_features a ON a.track_id=s.track_id AND a.feature_version=${FEATURE_VERSION} WHERE s.user_id=${userId} AND (${includeHistory} OR NOT EXISTS(SELECT 1 FROM library_state WHERE user_id=${userId}) OR EXISTS(SELECT 1 FROM library_membership m WHERE m.user_id=s.user_id AND m.track_id=s.track_id)) ORDER BY s.original_added_at,t.track_id`).map((r:any)=>({track:{...r.card,originalAddedAt:iso(r.original_added_at)},currentStatus:r.current_status,audioFeatures:r.normalized??null,currentDecision:r.current_decision??null})));
 }
 async insertExposure(input:ExposureInput){const v=ExposureInputSchema.parse(input);await this.db.transaction(async tx=>{
  const [saved]=await tx`SELECT 1 FROM saved_tracks WHERE user_id=${v.userId} AND track_id=${v.exposure.trackId}`;if(!saved)fail('TRACK_NOT_OWNED');
  const rows=await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at) VALUES(${v.exposure.exposureId},${v.userId},${v.exposure.trackId},${json(v)}::jsonb,${v.exposure.servedAt}) ON CONFLICT DO NOTHING RETURNING exposure_id`;
  if(!rows.length){const [same]=await tx`SELECT 1 FROM exposures WHERE exposure_id=${v.exposure.exposureId} AND user_id=${v.userId} AND payload=${json(v)}::jsonb`;if(!same)fail('EXPOSURE_CONFLICT');}
 });}
 async getExposure(userId:string,id:string):Promise<ExposureInput|null>{return this.db.transaction(async tx=>(await tx`SELECT payload FROM exposures WHERE user_id=${userId} AND exposure_id=${id}`)[0]?.payload??null);}
 async createDecision(input:DecisionInput):Promise<ReviewResult>{const v=DecisionInputSchema.parse(input);return this.db.transaction(async tx=>{
  const owner=await lockUser(tx,v.userId);
  const [old]=await tx`SELECT * FROM review_decisions WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey}`;
  if(old){if(old.request_fingerprint!==v.requestFingerprint || json(old.request)!==json(v.request)){
   const [same]=await tx`SELECT 1 FROM review_decisions WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey} AND request_fingerprint=${v.requestFingerprint} AND request=${json(v.request)}::jsonb`;if(!same)fail('IDEMPOTENCY_CONFLICT');}return old.result;}
  const [current]=await tx`SELECT d.result FROM current_decisions c JOIN review_decisions d USING(user_id,decision_id) WHERE c.user_id=${v.userId} AND c.track_id=${v.request.trackId}`;
  if(current && !['COMPLETE','UNDONE','FAILED_TERMINAL'].includes(current.result.status))fail('MUTATION_PENDING');
  const [undoing]=await tx`SELECT 1 FROM undo_commands u JOIN review_decisions d USING(user_id,decision_id) WHERE u.user_id=${v.userId} AND d.track_id=${v.request.trackId} AND u.settled_at IS NULL`;if(undoing)fail('MUTATION_PENDING');
  const [track]=await tx`SELECT t.card FROM saved_tracks s JOIN tracks t USING(track_id) WHERE s.user_id=${v.userId} AND s.track_id=${v.request.trackId}`;if(!track)fail('TRACK_NOT_OWNED');
  const result=ReviewResultSchema.parse({decisionId:v.decisionId,...v.request,status:'PENDING',mutationStep:'PENDING',mode:track.card.source==='synthetic'?'demo':'spotify',liked:null,archived:null,canUndo:false,label:null,labelState:'inactive',feedbackRevision:owner.feedback_revision,error:null,createdAt:v.createdAt,updatedAt:v.createdAt});
  await tx`INSERT INTO review_decisions(decision_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,result,created_at) VALUES(${v.decisionId},${v.userId},${v.request.trackId},${v.request.exposureId},${v.request.idempotencyKey},${v.requestFingerprint},${json(v.request)}::jsonb,${json(result)}::jsonb,${v.createdAt})`;
  await tx`INSERT INTO current_decisions(user_id,track_id,decision_id) VALUES(${v.userId},${v.request.trackId},${v.decisionId}) ON CONFLICT(user_id,track_id) DO UPDATE SET decision_id=excluded.decision_id`;
  return result;
 });}
 async getDecision(userId:string,id:string):Promise<ReviewResult|null>{return this.db.transaction(async tx=>(await tx`SELECT result FROM review_decisions WHERE user_id=${userId} AND decision_id=${id}`)[0]?.result??null);}
 async getCurrentDecision(userId:string,trackId:string):Promise<ReviewResult|null>{return this.db.transaction(async tx=>(await tx`SELECT d.result FROM current_decisions c JOIN review_decisions d USING(user_id,decision_id) WHERE c.user_id=${userId} AND c.track_id=${trackId}`)[0]?.result??null);}
 async history(userId:string,limit=100):Promise<ReviewResult[]>{if(!Number.isInteger(limit)||limit<1||limit>1000)fail('INVALID_LIMIT');return this.db.transaction(async tx=>(await tx`SELECT result FROM review_decisions WHERE user_id=${userId} ORDER BY created_at DESC LIMIT ${limit}`).map((r:any)=>r.result));}
 async createUndo(input:UndoCommandInput):Promise<UndoCommandInput>{const v=UndoCommandInputSchema.parse(input);return this.db.transaction(async tx=>{
  await lockUser(tx,v.userId);
  const [old]=await tx`SELECT payload FROM undo_commands WHERE user_id=${v.userId} AND idempotency_key=${v.request.idempotencyKey}`;
  if(old){if(old.payload.decisionId!==v.decisionId||old.payload.requestFingerprint!==v.requestFingerprint)fail('IDEMPOTENCY_CONFLICT');return old.payload;}
  const [d]=await tx`SELECT d.result,c.decision_id AS current_id FROM review_decisions d LEFT JOIN current_decisions c USING(user_id,track_id) WHERE d.user_id=${v.userId} AND d.decision_id=${v.decisionId}`;
  if(!d)fail('DECISION_NOT_FOUND');if(d.current_id!==v.decisionId)fail('STALE_DECISION');if(!d.result.canUndo)fail('MUTATION_PENDING');
  const [pending]=await tx`SELECT 1 FROM undo_commands WHERE user_id=${v.userId} AND decision_id=${v.decisionId} AND settled_at IS NULL`;if(pending)fail('MUTATION_PENDING');
  await tx`INSERT INTO undo_commands(command_id,user_id,decision_id,idempotency_key,request_fingerprint,payload,created_at) VALUES(${v.commandId},${v.userId},${v.decisionId},${v.request.idempotencyKey},${v.requestFingerprint},${json(v)}::jsonb,${v.createdAt})`;return v;
 });}
 /** Atomic local settlement only. Caller A must confirm remote mutations before supplying COMPLETE/UNDONE. */
 async settleDecision(userId:string,input:ReviewResult,expectedStatus:ReviewResult['status'],split:'train'|'holdout'){
  const v=ReviewResultSchema.parse(input);if(!['train','holdout'].includes(split))fail('INVALID_SPLIT');
  await this.db.transaction(async tx=>{
   const user=await lockUser(tx,userId);
   const [d]=await tx`SELECT d.result,c.decision_id AS current_id,d.result=${json(v)}::jsonb AS identical FROM review_decisions d LEFT JOIN current_decisions c USING(user_id,track_id) WHERE d.user_id=${userId} AND d.decision_id=${v.decisionId} FOR UPDATE OF d`;
   if(!d)fail('DECISION_NOT_FOUND');if(d.identical)return;if(d.current_id!==v.decisionId)fail('STALE_DECISION');
   const old=d.result as ReviewResult;if(old.status!==expectedStatus)fail('STATE_CONFLICT');
   for(const k of ['decisionId','trackId','action','exposureId','idempotencyKey','mode','createdAt'] as const)if(old[k]!==v[k])fail('DECISION_IDENTITY_CONFLICT');
   if(old.status==='UNDONE'||(old.status==='COMPLETE'&&v.status!=='UNDONE'))fail('INVALID_TRANSITION');
   const [prior]=await tx`SELECT f.* FROM feedback f JOIN review_decisions r USING(user_id,decision_id) WHERE f.user_id=${userId} AND r.track_id=${v.trackId} ORDER BY f.revision DESC LIMIT 1`;
   const changedLabel=old.labelState!==v.labelState || (v.status==='COMPLETE' && prior && prior.decision_id!==v.decisionId && prior.label!==null && !prior.revoked);
   const revision=Number(user.feedback_revision)+(changedLabel?1:0);
   if(v.feedbackRevision!==revision)fail('REVISION_CONFLICT');
   if(v.status==='UNDONE') {const [undo]=await tx`SELECT 1 FROM undo_commands WHERE user_id=${userId} AND decision_id=${v.decisionId}`;if(!undo)fail('UNDO_COMMAND_REQUIRED');}
   await tx`UPDATE review_decisions SET result=${json(v)}::jsonb WHERE user_id=${userId} AND decision_id=${v.decisionId}`;
   if(v.status==='UNDONE')await tx`UPDATE undo_commands SET settled_at=${v.updatedAt} WHERE user_id=${userId} AND decision_id=${v.decisionId} AND settled_at IS NULL`;
   if(changedLabel){await tx`UPDATE users SET feedback_revision=${revision} WHERE id=${userId}`;
    await tx`INSERT INTO feedback(user_id,decision_id,revision,label,revoked,split,occurred_at) VALUES(${userId},${v.decisionId},${revision},${v.label},${v.labelState==='revoked'},${prior?.split??split},${v.updatedAt}) ON CONFLICT(user_id,decision_id) DO UPDATE SET revision=excluded.revision,label=excluded.label,revoked=excluded.revoked,occurred_at=excluded.occurred_at`;
   }
   if(v.status==='COMPLETE'||v.status==='UNDONE'){
    const status=v.status==='UNDONE'?'saved':({KEEP:'kept',SKIP:'deferred',ARCHIVE:'archived',UNLIKE:'unliked'} as const)[v.action];
    await tx`UPDATE saved_tracks SET current_status=${status} WHERE user_id=${userId} AND track_id=${v.trackId}`;
    if(v.action==='ARCHIVE'||v.action==='UNLIKE'){
     if(v.status==='COMPLETE'){
      const removed=await tx`DELETE FROM library_membership WHERE user_id=${userId} AND track_id=${v.trackId} RETURNING track_id`;
      if(removed.length)await tx`UPDATE library_state SET source_total=GREATEST(0,source_total-1) WHERE user_id=${userId}`;
     }else{
      const added=await tx`INSERT INTO library_membership(user_id,track_id,job_id,pass) SELECT user_id,${v.trackId},job_id,pass FROM library_state WHERE user_id=${userId} ON CONFLICT DO NOTHING RETURNING track_id`;
      if(added.length)await tx`UPDATE library_state SET source_total=source_total+1 WHERE user_id=${userId}`;
     }
    }
    const [e]=await tx`SELECT payload FROM exposures WHERE user_id=${userId} AND exposure_id=${v.exposureId}`;
    await telemetry(tx,{eventId:crypto.randomUUID(),userId,modelVersion:e.payload.prediction.modelVersion,eventType:v.status==='UNDONE'?'undo':'decision',predictionScore:e.payload.prediction.removalProbability,uncertainty:e.payload.prediction.uncertainty,processingLatencyMs:Math.max(0,Date.parse(v.updatedAt)-Date.parse(v.createdAt)),occurredAt:v.updatedAt},{decisionId:v.decisionId,trackId:v.trackId,action:v.action,label:v.label,feedbackRevision:v.feedbackRevision});
   }
  });
 }
 async transitionMutation(input:MutationTransitionInput){const v=MutationTransitionInputSchema.parse(input);return this.db.transaction(async tx=>{
  const [old]=await tx`SELECT * FROM spotify_mutations WHERE user_id=${v.userId} AND decision_id=${v.decisionId} FOR UPDATE`;
  if(!old){if(v.expectedStatus!=='PENDING')fail('STATE_CONFLICT');await tx`INSERT INTO spotify_mutations(mutation_id,user_id,decision_id,status,step,attempts,archive_playlist_id,updated_at) VALUES(${v.mutationId},${v.userId},${v.decisionId},${v.status},${v.step},${v.attempts},${v.archivePlaylistId},${v.occurredAt})`;}
  else{if(old.mutation_id!==v.mutationId||old.status!==v.expectedStatus||old.attempts>v.attempts)fail('STATE_CONFLICT');await tx`UPDATE spotify_mutations SET status=${v.status},step=${v.step},attempts=${v.attempts},archive_playlist_id=${v.archivePlaylistId},updated_at=${v.occurredAt} WHERE user_id=${v.userId} AND mutation_id=${v.mutationId}`;}
  if(v.step==='ARCHIVED_PLAYLIST_INSERTED'&&v.archivePlaylistId)await tx`INSERT INTO archive_records(user_id,decision_id,track_id,playlist_id,inserted_at) SELECT user_id,decision_id,track_id,${v.archivePlaylistId},${v.occurredAt} FROM review_decisions WHERE user_id=${v.userId} AND decision_id=${v.decisionId} ON CONFLICT DO NOTHING`;
 });}
 async setArchivePlaylist(userId:string,playlistId:string){await this.db.transaction(async tx=>{await tx`INSERT INTO archive_playlists(user_id,spotify_playlist_id) VALUES(${userId},${playlistId}) ON CONFLICT(user_id) DO NOTHING`;});return this.getArchivePlaylist(userId);}
 async getArchivePlaylist(userId:string):Promise<string|null>{return this.db.transaction(async tx=>(await tx`SELECT spotify_playlist_id FROM archive_playlists WHERE user_id=${userId}`)[0]?.spotify_playlist_id??null);}
 async recordModelRun(input:ModelRunInput){const v=ModelRunInputSchema.parse(input);if(v.metrics.modelVersion!==v.modelVersion||v.metrics.trainedExamples!==v.trainedExamples)fail('MODEL_METRICS_CONFLICT');await this.db.transaction(async tx=>{
  const inserted=await tx`INSERT INTO model_runs(run_id,user_id,model_version,feature_version,payload,created_at) VALUES(${v.runId},${v.userId},${v.modelVersion},${v.featureVersion},${json(v)}::jsonb,${v.createdAt}) ON CONFLICT DO NOTHING RETURNING run_id`;
  if(!inserted.length){const [same]=await tx`SELECT 1 FROM model_runs WHERE user_id=${v.userId} AND model_version=${v.modelVersion} AND payload=${json(v)}::jsonb`;if(!same)fail('MODEL_VERSION_CONFLICT');}
 });}
 async latestModel(userId:string):Promise<ModelRunInput|null>{return this.db.transaction(async tx=>(await tx`SELECT payload FROM model_runs WHERE user_id=${userId} ORDER BY created_at DESC,run_id DESC LIMIT 1`)[0]?.payload??null);}
 async saveImportProgress(input:ImportProgressInput){const v=ImportProgressInputSchema.parse(input);await this.db.transaction(async tx=>{await tx`INSERT INTO import_jobs(user_id,job_type,payload) VALUES(${v.userId},'library_progress',${json(v)}::jsonb) ON CONFLICT(user_id,job_type) DO UPDATE SET payload=excluded.payload,updated_at=now()`;});}
 async importProgress(userId:string):Promise<ImportProgressInput|null>{return this.db.transaction(async tx=>{const [r]=await tx`SELECT payload FROM import_jobs WHERE user_id=${userId} AND job_type IN('library','library_progress') ORDER BY (job_type='library') DESC LIMIT 1`;return r?{userId,progress:r.payload.progress}:null;});}
 async trainingExamples(userId:string):Promise<{feedbackRevision:number;examples:z.infer<typeof TrainingExampleSchema>[]}>{return this.db.transaction(async tx=>{
  // Lock the owner for a revision-consistent snapshot, including concurrent undo.
  const owner=await lockUser(tx,userId);const rows=await tx`SELECT * FROM ml_training_examples WHERE user_id=${userId} ORDER BY labeled_at,decision_id`;
  return {feedbackRevision:owner.feedback_revision,examples:rows.map((r:any)=>({decisionId:r.decision_id,trackId:r.track_id,label:r.label,split:r.split,labeledAt:iso(r.labeled_at),features:r.features}))};
 });}
 recordTelemetry(input:TelemetryInput){return this.db.transaction(tx=>telemetry(tx,TelemetryInputSchema.parse(input)));}
 async analytics(userId:string,from:string,to:string):Promise<{bucket:string;eventType:string;modelVersion:string|null;events:number;predictionScore:number|null;uncertainty:number|null;latencyMs:number;kept:number;archived:number;unliked:number;skipped:number}[]>{
  if(!Number.isFinite(Date.parse(from))||!Number.isFinite(Date.parse(to))||Date.parse(from)>=Date.parse(to))fail('INVALID_TIME_RANGE');
  return this.db.transaction(async tx=>(await tx`SELECT date_trunc('minute',occurred_at) AS bucket,event_type,model_version,count(*)::int AS events,avg(prediction_score) AS score,avg(uncertainty) AS uncertainty,avg(processing_latency_ms) AS latency,
   count(*) FILTER(WHERE event_type='decision' AND context->>'action'='KEEP')::int AS kept,
   count(*) FILTER(WHERE event_type='decision' AND context->>'action'='ARCHIVE')::int AS archived,
   count(*) FILTER(WHERE event_type='decision' AND context->>'action'='UNLIKE')::int AS unliked,
   count(*) FILTER(WHERE event_type='decision' AND context->>'action'='SKIP')::int AS skipped
   FROM ml_telemetry WHERE user_id=${userId} AND occurred_at>=${from}::timestamptz AND occurred_at<${to}::timestamptz GROUP BY 1,2,3 ORDER BY 1,2,3`).map((r:any)=>({bucket:iso(r.bucket),eventType:r.event_type,modelVersion:r.model_version,events:r.events,predictionScore:r.score,uncertainty:r.uncertainty,latencyMs:r.latency,kept:r.kept,archived:r.archived,unliked:r.unliked,skipped:r.skipped})));
 }
}
