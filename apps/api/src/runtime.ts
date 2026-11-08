import {connectDatabase, PostgresA1Store, PostgresCalibrationStore, PostgresCalibrationBatchStore, PostgresPlaybackStore, Repository, MusicaeQueue, type Database} from '@sortfm/db';
import {PUBLIC_ROUTES} from '@sortfm/contracts';
import {createDemoQueue} from '@sortfm/contracts/fixtures';
import {QueueService} from './reviews/queue';
import {createReviewQueueModule,createReviewMutationModule} from './reviews/module';
import {FeedbackWorker} from './reviews/feedback';
import {ReviewService} from './reviews/service';
import {ReviewWorker} from './reviews/worker';
import {SpotifyMutations} from './spotify/mutations';
import {assembleLibraryCandidates,createMlClient,createRepositoryMl,createMlReadModule,createMlRetrainModule,type RepositoryMl} from './ml';
import {buildApp} from './app';
import {loadConfig} from './config';
import {loadSpotifyConfig} from './auth/config';
import {createSpotifyModule} from './auth/module';
import type {SpotifyHttp,Fetch} from './spotify/http';
import {CalibrationQueue,CalibrationService,CalibrationBatchService,createCalibrationModule} from './calibration';
import {createPlaybackModule,PlaybackService,PlaybackControls,type PlaybackTransport} from './playback';

/** Integration bootstrap. Missing external services leave the isolated demo usable. */
export async function buildRuntime(options: {
 env?: Record<string,string|undefined>;
 logger?: boolean;
 spotifyHttp?: SpotifyHttp;
 spotifyMutationFetch?: Fetch;
 playbackTransport?: PlaybackTransport;
} = {}) {
 const env=options.env??process.env;
 const config=loadConfig(env);
 const startupIssues:string[]=[];
 let database:Database|null=null;
 if(env.DATABASE_URL?.trim()) {
  try {
   database=connectDatabase(env.DATABASE_URL,env.DATABASE_SCHEMA??'sortfm');
   // Startup is read-only: migrations are an explicit operator step.
   await database.transaction(async tx=>{
    await tx`SELECT id FROM users LIMIT 0`;
    await tx`SELECT user_id FROM library_membership LIMIT 0`;
    await tx`SELECT feedback_revision FROM users LIMIT 0`;
    await tx`SELECT membership_revision FROM users LIMIT 0`;
    await tx`SELECT purpose FROM exposures LIMIT 0`;
    await tx`SELECT label_id FROM calibration_labels LIMIT 0`;
    await tx`SELECT command_id FROM calibration_undos LIMIT 0`;
    await tx`SELECT source FROM effective_feedback LIMIT 0`;
    await tx`SELECT track_id FROM available_audio_features LIMIT 0`;
    await tx`SELECT track_id FROM musicae_jobs LIMIT 0`;
    await tx`SELECT singleton FROM musicae_control LIMIT 0`;
   });
  } catch {
   await database?.close().catch(()=>{});
   database=null;
   startupIssues.push('DATABASE_UNAVAILABLE');
  }
 } else startupIssues.push('DATABASE_URL_REQUIRED');

 // Playback is optional: an unapplied 014 must not disable library or feedback.
 let playbackDatabaseReady=false;
 if(database) {
  try {
   await database.transaction(async tx=>{
    await tx`SELECT user_id,purpose,payload,updated_at FROM playback_grants LIMIT 0`;
    await tx`SELECT state_hash,user_id,purpose,payload,expires_at,consumed_at,completed_at FROM playback_oauth_attempts LIMIT 0`;
   });
   playbackDatabaseReady=true;
  } catch {startupIssues.push('PLAYBACK_DATABASE_UNAVAILABLE');}
 }

 // Batch2 is optional. Its sealed-label view must be installed by migration 015;
 // an older database must keep ordinary calibration, feedback and playback alive.
 let calibrationBatchDatabaseReady=false;
 if(database) {
  try {
   await database.transaction(async tx=>{
    const [migration]=await tx`SELECT name FROM schema_migrations WHERE name='015_calibration_batch2.sql'`;
    if(!migration)throw new Error('BATCH_MIGRATION_REQUIRED');
    await tx`SELECT batch_id,user_id,experiment,seed,algorithm_version,model_version,selected_at,snapshot FROM calibration_batches LIMIT 0`;
    await tx`SELECT batch_item_id,user_id,batch_id,track_id,sampling_group,assignment,provenance,candidate,selected_at,position,status,exposure_id,replacement_for FROM calibration_batch_items LIMIT 0`;
    await tx`SELECT user_id,batch_item_id,exposure_id FROM calibration_batch_exposures LIMIT 0`;
    await tx`SELECT user_id,idempotency_key,exposure_id,batch_item_id,created_at FROM calibration_batch_skips LIMIT 0`;
    await tx`SELECT user_id,decision_id,track_id,label,split,labeled_at,features FROM ml_training_examples LIMIT 0`;
   });
   calibrationBatchDatabaseReady=true;
  } catch {startupIssues.push('CALIBRATION_BATCH_DATABASE_UNAVAILABLE');}
 }

 const repository=database?new Repository(database):null;
 let spotify:ReturnType<typeof createSpotifyModule>|null=null;
 let playback:ReturnType<typeof createPlaybackModule>|null=null;
 const a1Store=database?new PostgresA1Store(database):null;
 const required=['SPOTIFY_CLIENT_ID','SPOTIFY_ALLOWED_USER_IDS','TOKEN_ENCRYPTION_KEY','SESSION_SECRET'] as const;
 const missing=required.filter(key=>!env[key]?.trim());
 startupIssues.push(...missing.map(key=>`${key}_REQUIRED`));
 if(a1Store&&missing.length===0) {
  try {
   const spotifyConfig=loadSpotifyConfig(env);
   spotify=createSpotifyModule({config:spotifyConfig,store:a1Store,...(options.spotifyHttp?{http:options.spotifyHttp}:{}),
    ...(playbackDatabaseReady?{playbackCallback:(...args:Parameters<ReturnType<typeof createPlaybackModule>['callback']>)=>playback!.callback(...args)}:{}),
   });
   if(playbackDatabaseReady&&database&&repository) {
    const service=new PlaybackService({config:spotifyConfig,store:new PostgresPlaybackStore(database),auth:spotify.auth,
     ...(options.playbackTransport?{transport:options.playbackTransport}:{}),
    });
    const controls=new PlaybackControls(service,{
     // Playback requires a completed import and current membership. The shared
     // repository intentionally retains its pre-import history fallback elsewhere.
     track:(ownerId,trackId)=>database!.transaction(async tx=>{
      const [saved]=await tx`SELECT t.card,s.original_added_at FROM library_state l
       JOIN library_membership m ON m.user_id=l.user_id
       JOIN saved_tracks s ON s.user_id=m.user_id AND s.track_id=m.track_id
       JOIN tracks t ON t.track_id=s.track_id
       WHERE l.user_id=${ownerId} AND m.track_id=${trackId}`;
      return saved?{...saved.card,originalAddedAt:new Date(saved.original_added_at).toISOString()}:null;
     }),
    });
    playback=createPlaybackModule({config:spotifyConfig,service,controls});
   }
  } catch {spotify=null;playback=null;startupIssues.push('SPOTIFY_CONFIG_INVALID');}
 }

 let ml:RepositoryMl|null=null;
 if(repository&&env.ML_SERVICE_URL&&env.ML_SERVICE_SHARED_SECRET) {
  try {ml=createRepositoryMl({repository,client:createMlClient({serviceUrl:env.ML_SERVICE_URL,sharedSecret:env.ML_SERVICE_SHARED_SECRET,allowRailwayPrivateHttp:env.ML_ALLOW_RAILWAY_PRIVATE_HTTP==='true'})});}
  catch {startupIssues.push('ML_CONFIG_INVALID');}
 } else if(env.ML_SERVICE_URL&&!env.ML_SERVICE_SHARED_SECRET)startupIssues.push('ML_SERVICE_SHARED_SECRET_REQUIRED');
 const metadataTraining={permittedForTraining:Boolean(env.METADATA_RIGHTS_BASIS?.trim()),...(env.METADATA_RIGHTS_BASIS?.trim()?{rightsBasis:env.METADATA_RIGHTS_BASIS.trim()}:{})};
 const reviews=spotify&&repository?createReviewQueueModule({
  queue:new QueueService(repository,{
   assemble:(rows,context)=>assembleLibraryCandidates(rows,{...context,now:new Date(context.now).toISOString(),metadataTraining}),
   ...(ml?{score:(userId,candidates,modelVersion)=>ml!.score(userId,candidates,modelVersion)}:{}),
  }),auth:spotify.auth,
  config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},
  ...(config.demoEnabled?{demoQueue:(query:Parameters<QueueService['get']>[1])=>createDemoQueue({...query,servedAt:new Date().toISOString(),exposureId:()=>crypto.randomUUID()})}:{}),
 }):null;
 const feedback=repository&&ml?new FeedbackWorker(repository,ml,{onError:code=>{
  // Codes are fixed worker diagnostics; never log model payloads or account credentials.
  if(options.logger)console.warn(code);
 }}):null;
 const reviewWorker=spotify&&repository?new ReviewWorker(repository,
  new SpotifyMutations(spotify.auth,spotify.auth.http,options.spotifyMutationFetch?{fetch:options.spotifyMutationFetch}:{}),
  {auth:spotify.auth,...(feedback?{feedback}:{}),onError:code=>{if(options.logger)console.warn(code);}}):null;
 const mutations=spotify&&repository&&reviewWorker?createReviewMutationModule({
  auth:spotify.auth,config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},
  service:new ReviewService(repository,{auth:spotify.auth,worker:reviewWorker}),worker:reviewWorker,
  enableWrites:()=>spotify!.auth.enableReviewWrites(),
 }):null;
 const audio=database?new MusicaeQueue(database):null;
 const modelReads=spotify&&repository&&a1Store&&audio?createMlReadModule({
  auth:spotify.auth,config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},ml,
  getSummary:userId=>a1Store.transaction(tx=>tx.getSummary(userId)),
  audioProgress:userId=>audio.audioStatus(userId),latestModel:userId=>repository.latestModel(userId),
 }):null;
 const modelRetrain=spotify?createMlRetrainModule({
  auth:spotify.auth,config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},ml,
 }):null;
 const calibrationStore=database?new PostgresCalibrationStore(database):null;
 const calibration=spotify&&calibrationStore?createCalibrationModule({
  auth:spotify.auth,config:{...config,secureCookies:config.apiOrigin.startsWith('https:')},
  service:new CalibrationService(calibrationStore,{...(feedback?{feedback}:{})}),
  // Saved batches resume without a scorer; new creation explicitly reports
  // unavailable scoring. Labels continue through the existing feedback worker.
  ...(calibrationBatchDatabaseReady&&database?{batch:new CalibrationBatchService(new PostgresCalibrationBatchStore(database),{
   assemble:(rows,{userId,now})=>assembleLibraryCandidates(rows,{userId,now:new Date(now).toISOString(),metadataTraining}),
   ...(ml?{score:(userId,candidates,modelVersion)=>ml!.score(userId,candidates,modelVersion)}:{}),
  })}:{}),
  queue:new CalibrationQueue(calibrationStore,{
   assemble:(rows,{userId,now})=>assembleLibraryCandidates(rows,{userId,now:new Date(now).toISOString(),metadataTraining}),
   ...(ml?{score:(userId,candidates)=>ml!.score(userId,candidates)}:{}),
  }),
 }):null;

 try {
  const app=await buildApp({config,logger:options.logger,capabilities:{database:database!==null,spotify:spotify!==null,ml:ml!==null&&reviews!==null},registerRoutes:async app=>{
   if(feedback){app.addHook('onReady',async()=>{feedback.start();});app.addHook('onClose',async()=>{await feedback.close();});}
   if(spotify) {await spotify.registerRoutes(app);await playback?.registerRoutes(app);await reviews?.registerRoutes(app);await mutations?.registerRoutes(app);await modelReads?.registerRoutes(app);await modelRetrain?.registerRoutes(app);await calibration?.registerRoutes(app);}
   else for(const path of [PUBLIC_ROUTES.authStart.path,PUBLIC_ROUTES.authCallback.path]) {
    app.get(path,async(_request,reply)=>reply.code(503).send({code:'SPOTIFY_NOT_CONFIGURED',message:'Spotify connection is unavailable until server configuration and database readiness are complete.',retryable:false}));
   }
  }});
  let closing:Promise<void>|undefined;
  const close=()=>closing??=(async()=>{try{await app.close();}finally{await database?.close();}})();
  return {app,config,startupIssues,close};
 } catch(error) {await reviewWorker?.close();await feedback?.close();await database?.close();throw error;}
}
