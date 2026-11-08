import {expect,test} from 'bun:test';
import {reviewExclusionManifestDigest} from '@sortfm/db';
import {buildRuntime} from '../src/runtime';
import {validatePilotRuntime} from '../src/reviews/pilot-runtime';
import {loadConfig} from '../src/config';
const schema='pilot_c2_0123456789abcdef01234567';
const value={ownerId:'spotify:pilot.owner',pilotSchema:schema,sortedTrackIds:['0000000000000000000001']};
const manifest={...value,sha256:reviewExclusionManifestDigest(value)},pilot={manifest,approvedManifestSha256:manifest.sha256};
const env={NODE_ENV:'test',DEMO_MODE_ENABLED:'false',DATABASE_URL:'postgres://synthetic@127.0.0.1:1/test',DATABASE_SCHEMA:schema,
 PUBLIC_WEB_ORIGIN:'http://127.0.0.1:5173',PUBLIC_API_ORIGIN:'http://127.0.0.1:3001',ML_SERVICE_URL:'http://127.0.0.1:8000',
 ML_SERVICE_SHARED_SECRET:'synthetic-ml-secret-'.repeat(3),SPOTIFY_CLIENT_ID:'synthetic-client',SPOTIFY_ALLOWED_USER_IDS:'pilot.owner',
 TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'synthetic-session-'.repeat(3)};
test('pilot validates pinned manifest and explicit isolated configuration before connecting',()=>{
 const validated=validatePilotRuntime(env,loadConfig(env),pilot);
 expect(validated.manifest).toEqual(manifest);expect(validated.manifest).not.toBe(manifest);
 for(const overrides of [
  {DEMO_MODE_ENABLED:'true'},{DATABASE_URL:''},{DATABASE_SCHEMA:'sortfm'},
  {PUBLIC_WEB_ORIGIN:'https://sort.fm'},{PUBLIC_API_ORIGIN:'https://api.sort.fm'},
  {ML_SERVICE_URL:'https://ml.example.test'},{ML_SERVICE_URL:'http://127.0.0.1:8000/path'},
  {HOST:'0.0.0.0'},{PORT:'3002'},{SPOTIFY_ALLOWED_USER_IDS:'pilot.owner,other'},
  {SPOTIFY_ALLOWED_USER_IDS:'other'},{SESSION_SECRET:''},{TOKEN_ENCRYPTION_KEY:''},{ML_SERVICE_SHARED_SECRET:''},
  {ML_SERVICE_SHARED_SECRET:env.SESSION_SECRET},{ML_ALLOW_RAILWAY_PRIVATE_HTTP:'true'},
 ]){const next={...env,...overrides};expect(()=>validatePilotRuntime(next,loadConfig(next),pilot)).toThrow('PILOT_CONFIG_INVALID');}
 for(const manifest of [{...pilot.manifest,sha256:'a'.repeat(64)},{...pilot.manifest,sortedTrackIds:['bad']},{...pilot.manifest,ownerId:'spotify:other'}])expect(()=>validatePilotRuntime(env,loadConfig(env),{...pilot,manifest})).toThrow('PILOT_CONFIG_INVALID');
 expect(()=>validatePilotRuntime(env,loadConfig(env),{...pilot,approvedManifestSha256:'b'.repeat(64)})).toThrow('PILOT_CONFIG_INVALID');
});
test('pilot rejects unguarded transport overrides before any database/provider activity',async()=>{
 await expect(buildRuntime({env,pilot,spotifyMutationFetch:async()=>{throw Error('must not run');}})).rejects.toThrow('PILOT_TRANSPORT_OVERRIDE');
});
test('environment variables alone cannot activate pilot behavior',async()=>{
 const runtime=await buildRuntime({env:{NODE_ENV:'test',PILOT_ENABLED:'true',PILOT_MANIFEST_SHA256:manifest.sha256}});
 try{expect(runtime.pilot).toBeUndefined();expect((await runtime.app.inject('/api/demo/bootstrap')).statusCode).toBe(200);}finally{await runtime.close();}
});

test('connectDatabase forwards only an explicit fence and preserves default behavior',async()=>{
 const {connectDatabase}=await import('@sortfm/db');
 const plain=connectDatabase(env.DATABASE_URL),guarded=connectDatabase(env.DATABASE_URL,schema,{reviewExclusions:manifest});
 try{expect(plain.reviewExclusions).toBeUndefined();expect(plain.schema).toBe('sortfm');expect(guarded.reviewExclusions?.sha256).toBe(manifest.sha256);}
 finally{await plain.close();await guarded.close();}
 expect(()=>connectDatabase(env.DATABASE_URL,schema,{reviewExclusions:{...manifest,sha256:'b'.repeat(64)}})).toThrow('INVALID_REVIEW_EXCLUSIONS');
});

test('mutation opt-in is separately digest-approved, typed and copied before startup awaits',()=>{
 const value={...pilot.manifest,allowSpotifyMutations:true},manifest={...value,sha256:reviewExclusionManifestDigest(value)};
 expect(manifest.sha256).not.toBe(pilot.manifest.sha256);
 expect(()=>validatePilotRuntime(env,loadConfig(env),{...pilot,manifest})).toThrow('PILOT_CONFIG_INVALID');
 const options={manifest,approvedManifestSha256:manifest.sha256,mutationFetch:async()=>Response.json({})};
 const validated=validatePilotRuntime(env,loadConfig(env),options);manifest.allowSpotifyMutations=false;manifest.sortedTrackIds.push('0000000000000000000002');
 expect(validated.manifest.allowSpotifyMutations).toBe(true);expect(validated.manifest.sortedTrackIds).toHaveLength(1);
 for(const allowSpotifyMutations of [false,undefined,'true'] as const){const v={...pilot.manifest,...(allowSpotifyMutations===undefined?{}:{allowSpotifyMutations})},m={...v,sha256:reviewExclusionManifestDigest(v as typeof value)};
  expect(()=>validatePilotRuntime(env,loadConfig(env),{manifest:m as typeof manifest,approvedManifestSha256:m.sha256,mutationFetch:async()=>Response.json({})})).toThrow('PILOT_CONFIG_INVALID');
 }
});
