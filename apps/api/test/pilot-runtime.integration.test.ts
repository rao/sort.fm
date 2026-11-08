import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {Database,migrate,PostgresA1Store,Repository,reviewExclusionManifestDigest} from '@sortfm/db';
import {QueueResultSchema,ReviewResultSchema,type PolicyDecision,type PolicySelectRequest,type FitRequest} from '@sortfm/contracts';
import {demoTracks,createDemoQueue,emptyMetrics,untrainedPrediction} from '@sortfm/contracts/fixtures';
import {buildRuntime} from '../src/runtime';
import {loadSpotifyConfig} from '../src/auth/config';
const url=process.env.TEST_DATABASE_URL;
const owner='pilot.synthetic.owner',userId=`spotify:${owner}`,origin='http://127.0.0.1:5173';
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
async function fixture(){
 const db=new Database(url!,`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`);await migrate(db);
 const repo=new Repository(db);await repo.upsertUser({id:userId,spotifyId:owner,displayName:'Synthetic pilot',avatarUrl:null});
 const tracks=Array.from({length:6},(_,i)=>({...demoTracks[i]!,trackId:String(i+1).padStart(22,'0'),source:'spotify' as const,spotifyUri:`spotify:track:${String(i+1).padStart(22,'0')}` as const,isPlayable:true}));
 await repo.upsertSavedTracks(tracks.map(track=>({userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved' as const})));
 await new PostgresA1Store(db).transaction(tx=>tx.completeImportMembership({userId,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:tracks.map(t=>t.trackId),sourceTotal:tracks.length,observedAt:new Date().toISOString()}));
 const value={ownerId:userId,pilotSchema:db.schema,sortedTrackIds:[tracks[0]!.trackId]},manifest={...value,sha256:reviewExclusionManifestDigest(value)};
 const env={NODE_ENV:'test',DEMO_MODE_ENABLED:'false',DATABASE_URL:url,DATABASE_SCHEMA:db.schema,PUBLIC_WEB_ORIGIN:origin,PUBLIC_API_ORIGIN:'http://127.0.0.1:3001',ML_SERVICE_URL:'http://127.0.0.1:8000',ML_SERVICE_SHARED_SECRET:'synthetic-local-ml-secret-'.repeat(3),SPOTIFY_CLIENT_ID:'synthetic-client',SPOTIFY_ALLOWED_USER_IDS:owner,TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'synthetic-local-session-'.repeat(3),METADATA_RIGHTS_BASIS:'Authored synthetic runtime fixtures'};
 return {db,repo,tracks,env,manifest,pilot:{manifest,approvedManifestSha256:manifest.sha256},close:async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}};
}
async function waitFor(check:()=>Promise<boolean>){for(let n=0;n<100;n++){if(await check())return;await Bun.sleep(10);}throw Error('Synthetic runtime did not settle');}
function fakeMl(fallback=false){
 const calls:string[]=[],decisions=new Map<string,PolicyDecision>();
 const transport=async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const target=new URL(String(input)),path=target.pathname;calls.push(path);expect(target.origin).toBe('http://127.0.0.1:8000');expect(init?.redirect).toBe('error');
  const body=init?.body?JSON.parse(String(init.body)):undefined;
  if(path==='/fit'){
   const r=body as FitRequest,held=r.examples.filter(x=>x.split==='holdout'),modelVersion=`synthetic-${r.feedbackRevision}`;
   return Response.json({userId:r.userId,featureVersion:r.featureVersion,feedbackRevision:r.feedbackRevision,modelVersion,trainedExamples:0,metrics:{...emptyMetrics,modelVersion,labeledExamples:r.examples.length,heldOutExamples:held.length,heldOutPositive:held.filter(x=>x.label===1).length,heldOutNegative:held.filter(x=>x.label===0).length}});
  }
  if(path==='/score'){const modelVersion=body.modelVersion??'synthetic-0';return Response.json({userId:body.userId,featureVersion:body.featureVersion,modelVersion,predictions:body.candidates.map((c:{trackId:string})=>({trackId:c.trackId,prediction:{...untrainedPrediction,modelVersion}}))});}
  if(path==='/policy/select'){
   if(fallback)return Response.json({code:'POLICY_STATE_UNAVAILABLE',message:'Synthetic offline',retryable:true},{status:503});
   const r=body as PolicySelectRequest,candidate=r.candidates[0]!,createdAt=new Date().toISOString();
   const d:PolicyDecision={userId:r.userId,exposureId:r.exposureId,trackId:candidate.trackId,candidate,prediction:{...untrainedPrediction,modelVersion:r.modelVersion!},modelVersion:r.modelVersion!,featureVersion:r.featureVersion,feedbackRevision:r.feedbackRevision!,policyVersion:'policy:synthetic:v1',policyStateVersion:'state:synthetic:v1',contextVersion:'context:synthetic:v1',rewardVersion:'reward:synthetic:v1',seed:r.seed,step:1,config:r.config,selection:{index:0,trackId:candidate.trackId,strategy:'explore',selectionMethod:r.config.strategy,predictedReward:0.1,baselineScore:0.2,selectionScore:0.3,uncertainty:0.4,explorationBonus:0.2,informationGain:0.1,propensityEstimate:null,greedyTrackId:candidate.trackId,eligibleCount:r.candidates.length,explorationAllowed:true,reasons:['synthetic'],context:[1]},candidateSetHash:createHash('sha256').update(JSON.stringify(r.candidates)).digest('hex'),candidateTrackIds:r.candidates.map(c=>c.trackId),candidateCount:r.candidates.length,availableCount:r.candidates.length,contextNames:['intercept'],trainedRewards:0,rankedTrackIds:null,createdAt};
   decisions.set(r.exposureId,d);return Response.json(d);
  }
  if(path==='/policy/exposure'){
   const d=decisions.get(target.searchParams.get('exposureId')!)!;
   if(!d)return Response.json({code:'POLICY_EXPOSURE_NOT_FOUND',message:'Synthetic absent',retryable:false},{status:404});
   return Response.json({decision:d,feedback:[],eligibility:null,reservation:{exposureId:d.exposureId,reservedAt:d.createdAt,expiresAt:new Date(Date.parse(d.createdAt)+300000).toISOString(),evaluatedAt:new Date().toISOString(),status:'active',closedAt:null,closureReason:null}});
  }
  if(path==='/policy/associate')return Response.json({userId:body.userId,eventId:body.event.eventId,sequence:body.event.sequence,recordedAt:new Date().toISOString(),duplicate:false,fitReceipt:body.fitReceipt,eligibleForLearning:false});
  if(path==='/policy/release'){const now=new Date().toISOString();return Response.json({...body,reason:undefined,trackId:decisions.get(body.exposureId)?.trackId??'0000000000000000000002',outcome:'released',recordedAt:now,expiresAt:new Date(Date.now()+300000).toISOString(),effectiveClosedAt:now});}
  throw Error(`Unexpected synthetic ML request ${path}`);
 };
 return {transport,calls};
}
for(const strategy of ['c1','linucb','epsilon_greedy','fallback'] as const)test.skipIf(!url)(`${strategy}: complete guarded runtime keeps OAuth/KEEP/SKIP/Undo inside pilot publication fence`,async()=>{
 const f=await fixture(),ml=fakeMl(strategy==='fallback'),providerCalls:string[]=[];let runtime:Runtime|undefined;
 const env={...f.env,...(strategy==='c1'?{}:{C2_POLICY_ENABLED:'true',REVIEW_SELECTION_POLICY:strategy==='fallback'?'linucb':strategy})};
 try{
  // Retained source exposure has no pilot publication and may never authorize a command.
  const inherited=createDemoQueue().items[0]!;
  await f.repo.insertExposure({userId,exposure:{...inherited.exposure,trackId:f.tracks[1]!.trackId},prediction:inherited.prediction,features:{featureVersion:'sortfm.features.v1',values:{},provenance:'synthetic',permittedForTraining:false}});
  runtime=await buildRuntime({env,pilot:{...f.pilot,mlFetch:ml.transport,oauthFetch:async(target,init)=>{
   providerCalls.push(target);expect(init?.redirect).toBe('error');
   if(target==='https://accounts.spotify.com/api/token')return Response.json({access_token:'synthetic-private-access',refresh_token:'synthetic-private-refresh',expires_in:3600,token_type:'Bearer',scope:loadSpotifyConfig(env).scopes.join(' ')});
   if(target==='https://api.spotify.com/v1/me')return Response.json({id:owner,display_name:'Synthetic pilot',images:[]});
   throw Error('Unexpected provider call');
  }}});
  expect(runtime.startupIssues).toEqual([]);expect(providerCalls).toEqual([]);expect(ml.calls).toEqual([]);
  const start=await runtime.app.inject('/api/auth/spotify/start'),cookie=start.cookies[0]!,state=new URL(start.headers.location!).searchParams.get('state');
  const callback=await runtime.app.inject({url:`/api/auth/spotify/callback?state=${state}&code=synthetic`,cookies:{[cookie.name]:cookie.value}});
  expect(callback.statusCode).toBe(302);const session=callback.cookies.find(c=>c.name==='sortfm_session'&&c.value)!;
  const headers={cookie:`${session.name}=${session.value}`,origin};
  const me=await runtime.app.inject({url:'/api/me',headers});expect(me.body).not.toContain('synthetic-private');expect(me.json().capabilities).toEqual({spotifyRead:true,spotifyWrite:false,playback:false});
  for(const endpoint of ['/api/library/sync','/api/player/token','/api/player/connect','/api/ml/retrain','/api/calibration/labels','/api/unknown'])expect((await runtime.app.inject({method:'POST',url:endpoint,headers,payload:{}})).statusCode).toBe(403);
  expect((await runtime.app.inject({method:'POST',url:'/api/decisions',headers,payload:{trackId:f.tracks[1]!.trackId,exposureId:inherited.exposure.exposureId,action:'KEEP',idempotencyKey:crypto.randomUUID()}})).statusCode).toBe(403);
  await runtime.pilot!.ml.fit(userId); // Private bootstrap seam, never a public pilot fit route.
  for(const action of ['KEEP','SKIP'] as const){
   const response=await runtime.app.inject({url:'/api/queue?limit=1',headers});expect(response.statusCode).toBe(200);
   const queue=QueueResultSchema.parse(response.json()),item=queue.items[0]!;expect(item).toBeDefined();expect(item.track.trackId).not.toBe(f.tracks[0]!.trackId);
   const saved=await runtime.pilot!.repository.getExposure(userId,item.exposure.exposureId);expect(saved?.exposure.trackId).toBe(item.track.trackId);
   if(strategy==='linucb'||strategy==='epsilon_greedy')expect(item.exposure.selectionMethod).toBe(strategy);
   if(strategy==='fallback')expect(item.exposure.policyVersion).toBe('queue:c1-fallback:linucb:v1');
   const request={trackId:item.track.trackId,exposureId:item.exposure.exposureId,action,idempotencyKey:crypto.randomUUID()};
   expect((await runtime.app.inject({method:'POST',url:'/api/decisions',headers,payload:{...request,action:'UNLIKE'}})).statusCode).toBe(403);
   const posted=await runtime.app.inject({method:'POST',url:'/api/decisions',headers,payload:request});expect(posted.statusCode).toBe(202);
   const result=ReviewResultSchema.parse(posted.json());
   await waitFor(async()=> (await runtime!.pilot!.repository.getDecision(userId,result.decisionId))?.status==='COMPLETE');
   const replay=await runtime.app.inject({method:'POST',url:'/api/decisions',headers,payload:request});expect(replay.statusCode).toBe(200);expect(replay.json().decisionId).toBe(result.decisionId);
   const undo={idempotencyKey:crypto.randomUUID()},undoUrl=`/api/decisions/${result.decisionId}/undo`;
   expect((await runtime.app.inject({method:'POST',url:undoUrl,headers,payload:undo})).statusCode).toBe(409);
   await waitFor(async()=> (await runtime!.pilot!.repository.getDecision(userId,result.decisionId))?.status==='UNDONE');
   expect((await runtime.app.inject({method:'POST',url:undoUrl,headers,payload:undo})).json().status).toBe('UNDONE');
   await runtime.pilot!.ml.fit(userId);
  }
  expect(providerCalls).toEqual(['https://accounts.spotify.com/api/token','https://api.spotify.com/v1/me']);
  expect(await f.db.transaction(tx=>tx`SELECT 1 FROM import_jobs`)).toHaveLength(0);
  expect((await f.repo.library(userId)).map(row=>row.track.trackId)).toHaveLength(6);
 }finally{await runtime?.close();await f.close();}
},30000);
test.skipIf(!url)('pilot startup rejects missing/partial policy storage before OAuth or workers',async()=>{
 for(const damage of ['migration','table','column','worker_table','foreign_owner'] as const){
  const f=await fixture();let calls=0;
  try{
   if(damage==='migration')await f.db.transaction(tx=>tx`DELETE FROM schema_migrations WHERE name='016_policy.sql'`);
   if(damage==='table')await f.db.sql.unsafe(`DROP TABLE "${f.db.schema}".policy_release_commands`);
   if(damage==='worker_table')await f.db.sql.unsafe(`ALTER TABLE "${f.db.schema}".review_work RENAME TO disabled_review_work`);
   if(damage==='foreign_owner')await f.repo.upsertUser({id:'spotify:foreign',spotifyId:'foreign',displayName:'Synthetic foreign',avatarUrl:null});
   if(damage==='column')await f.db.sql.unsafe(`ALTER TABLE "${f.db.schema}".policy_selection_intents DROP COLUMN publication`);
   await expect(buildRuntime({env:f.env,pilot:{...f.pilot,oauthFetch:async()=>{calls++;throw Error();},mlFetch:async()=>{calls++;throw Error();}}})).rejects.toThrow('PILOT_STORAGE_UNAVAILABLE');
   expect(calls).toBe(0);expect(await f.db.transaction(tx=>tx`SELECT 1 FROM review_work_leases`)).toHaveLength(0);
  }finally{await f.close();}
 }
},30000);
