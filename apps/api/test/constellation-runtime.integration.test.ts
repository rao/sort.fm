import {expect,test} from 'bun:test';
import {TasteConstellationLiveSchema} from '@sortfm/contracts';
import {Database,migrate,PostgresA1Store,Repository,reviewExclusionManifestDigest} from '@sortfm/db';
import {json} from '../../../packages/db/src/client';
import {buildRuntime} from '../src/runtime';
import {loadSpotifyConfig} from '../src/auth/config';
import {sessionHash,TokenCipher} from '../src/auth/crypto';
import {SpotifyHttp} from '../src/spotify/http';
import {PlaybackTransport} from '../src/playback';
import {row} from '../src/calibration/test-fixtures';

const url=process.env.TEST_DATABASE_URL,owner='spotify:constellation.fixture',token='1'.repeat(43);
const id=(n:number)=>String(n).padStart(22,'0');
type Runtime=Awaited<ReturnType<typeof buildRuntime>>;
async function fixture(pilot=false){
 const schema=pilot?`pilot_c2_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`:`test_graph_runtime_${crypto.randomUUID().replaceAll('-','')}`;
 const db=new Database(url!,schema),at=new Date().toISOString();await migrate(db);
 const repo=new Repository(db),store=new PostgresA1Store(db);
 const env={NODE_ENV:'test',DATABASE_URL:url,DATABASE_SCHEMA:schema,DEMO_MODE_ENABLED:'false',
  PUBLIC_WEB_ORIGIN:'http://127.0.0.1:5173',PUBLIC_API_ORIGIN:'http://127.0.0.1:3001',
  SPOTIFY_CLIENT_ID:'constellation-fixture-client',SPOTIFY_ALLOWED_USER_IDS:'constellation.fixture',
  TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64'),SESSION_SECRET:'constellation-fixture-session-'.repeat(3),
  ...(pilot?{ML_SERVICE_URL:'http://127.0.0.1:8000',ML_SERVICE_SHARED_SECRET:'constellation-fixture-ml-'.repeat(3)}:{})};
 const config=loadSpotifyConfig(env),cipher=new TokenCipher(config.encryptionKey);
 await store.transaction(async tx=>{
  await tx.putAccount({user:{id:owner,spotifyId:'constellation.fixture',displayName:'Authored fixture',avatarUrl:null},
   accessToken:cipher.seal('fixture-access',`${owner}:access`),refreshToken:cipher.seal('fixture-refresh',`${owner}:refresh`),
   expiresAt:Date.now()-1000,scopes:['user-library-read'],credentialVersion:crypto.randomUUID(),revoked:false,refreshLease:null});
  await tx.putSession({hash:sessionHash(token,config.sessionSecret),userId:owner,expiresAt:Date.now()+600000});
 });
 await repo.upsertSavedTracks(Array.from({length:5},(_,i)=>({userId:owner,track:row(i+1).track,originalAddedAt:at,syncedAt:at,currentStatus:'saved' as const})));
 await store.transaction(tx=>tx.completeImportMembership({userId:owner,expectedMembershipRevision:0,jobId:crypto.randomUUID(),pass:0,trackIds:[1,2,3,4,5].map(id),sourceTotal:5,observedAt:at}));
 const state=()=>db.transaction(async tx=>{
  const tables=await tx`SELECT tablename FROM pg_tables WHERE schemaname=${db.schema} ORDER BY tablename`;const result:Record<string,unknown>={};
  for(const table of tables){const name=String(table.tablename).replaceAll('"','""');const [r]=await tx.unsafe(`SELECT count(*)::int AS n,md5(COALESCE(string_agg(v::text,'' ORDER BY v::text),'')) AS hash FROM (SELECT row_to_json(t)::text AS v FROM "${name}" t) x`);result[table.tablename]=r;}return result;
 });
 const calls:string[]=[],deny=async(input:unknown)=>{calls.push(String(input));throw Error('External transport forbidden in synthetic constellation fixture');};
 const value={ownerId:owner,pilotSchema:schema,sortedTrackIds:[id(1)]},manifest={...value,sha256:reviewExclusionManifestDigest(value)};
 return {db,env,at,state,calls,options:pilot?{env,pilot:{manifest,approvedManifestSha256:manifest.sha256,oauthFetch:deny,mlFetch:deny}}:{env,spotifyHttp:new SpotifyHttp({fetch:deny}),spotifyMutationFetch:deny,playbackTransport:new PlaybackTransport({fetch:deny})},
  close:async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}};
}

test.skipIf(!url)('runtime serves only eligible observations through real stored sessions without modifying fixture tables or calling providers',async()=>{
 const f=await fixture();let runtime:Runtime|undefined;
 try{
  // A revoked historical calibration holdout remains forbidden even after a
  // newer train row. Other tombstones must not revive a previous preference.
  for(const [n,split,label,revoked,revision] of [[1,'holdout',null,true,1],[1,'train',0,false,2],[2,'train',0,false,3],[3,'train',1,false,4],[4,'train',0,false,5],[4,'train',null,true,6]] as const)await f.db.transaction(async tx=>{
   const exposure=crypto.randomUUID();await tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at,purpose) VALUES(${exposure},${owner},${id(n)},${json({features:{permittedForTraining:true}})}::jsonb,${f.at},'calibration')`;
   await tx`INSERT INTO calibration_labels(label_id,user_id,track_id,exposure_id,idempotency_key,request_fingerprint,request,submitted_label,label,revoked,revision,split,created_at,updated_at) VALUES(${crypto.randomUUID()},${owner},${id(n)},${exposure},${crypto.randomUUID()},'fixture','{}',${label??0},${label},${revoked},${revision},${split},${f.at},${f.at})`;
  });
  await f.db.transaction(tx=>tx`INSERT INTO audio_features(track_id,feature_version,provider,raw,normalized,data_quality,fetched_at) VALUES(${id(2)},'sortfm.features.v1','soundnet','{}',${json({featureVersion:'sortfm.features.v1',provenance:'soundnet',permittedForTraining:true,values:{energy:0,happiness:null,saved_age_days:5}})}::jsonb,'{}',${f.at})`);
  runtime=await buildRuntime(f.options);expect(runtime.startupIssues).toEqual([]);
  const before=await f.state(),cookies={sortfm_session:token};
  const response=await runtime.app.inject({url:'/api/ml/constellation',cookies});
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  const graph=TasteConstellationLiveSchema.parse(response.json());
  expect(graph.tracks.map(t=>t.id)).toEqual([2,3,4,5].map(id));expect(graph.tracks.map(t=>t.label)).toEqual(['keep','remove',null,null]);
  expect(graph.tracks[0]!.audio).toEqual({energy:0,happiness:null});expect(graph.tracks.slice(1).every(t=>Object.keys(t.audio).length===0)).toBe(true);
  expect(graph.modelVersion).toBeNull();expect(graph.tracks.every(t=>t.prediction===null)).toBe(true);expect(response.body).not.toContain(owner);
  for(const [request,status] of [[{url:'/api/ml/constellation'},401],[{url:'/api/ml/constellation?userId=other',cookies},400],[{url:'/api/ml/constellation',cookies,headers:{origin:'https://foreign.invalid'}},403]] as const){
   const rejected=await runtime.app.inject(request);expect(rejected.statusCode).toBe(status);expect(rejected.headers['cache-control']).toBe('no-store');
  }
  expect(await f.state()).toEqual(before);expect(f.calls).toEqual([]);
  // A privacy dependency can disappear after startup; the route must not fall
  // back to an unfiltered library or disclose database diagnostics.
  await f.db.transaction(tx=>tx.unsafe('ALTER VIEW unified_feedback RENAME TO unavailable_feedback'));
  try{const unavailable=await runtime.app.inject({url:'/api/ml/constellation',cookies});expect(unavailable.statusCode).toBe(503);expect(unavailable.json()).toEqual({code:'CONSTELLATION_UNAVAILABLE',message:'Taste Constellation is temporarily unavailable. Retry later.',retryable:true});expect(unavailable.headers['cache-control']).toBe('no-store');}
  finally{await f.db.transaction(tx=>tx.unsafe('ALTER VIEW unavailable_feedback RENAME TO unified_feedback'));}
 }finally{await runtime?.close();await f.close();}
},30000);

test.skipIf(!url)('pilot runtime denies constellation before reading its privacy projection',async()=>{
 const f=await fixture(true);let runtime:Runtime|undefined;
 try{
  runtime=await buildRuntime(f.options);expect(runtime.pilot).toBeDefined();
  // Deliberately corrupt graph-only metadata: a reached projection would fail503.
  await f.db.transaction(tx=>tx`UPDATE tracks SET card='{}' WHERE track_id=${id(2)}`);
  const before=await f.state();
  for(const cookies of [{sortfm_session:token},undefined]){const response=await runtime.app.inject({url:'/api/ml/constellation',cookies});expect(response.statusCode).toBe(403);expect(response.json().code).toBe('PILOT_ACTION_NOT_ALLOWED');expect(response.headers['cache-control']).toBe('no-store');}
  expect(await f.state()).toEqual(before);expect(f.calls).toEqual([]);
 }finally{await runtime?.close();await f.close();}
},30000);
