/** Public read routes with the real AuthService and synthetic persisted sessions. */
import {afterEach,expect,test} from 'bun:test';
import {PUBLIC_ROUTES,type ModelMetrics} from '@sortfm/contracts';
import {buildApp} from '../app';
import {loadSpotifyConfig} from '../auth/config';
import {sessionHash,TokenCipher} from '../auth/crypto';
import {AuthService} from '../auth/service';
import {TestStore} from '../auth/test-support/store';
import {SpotifyHttp} from '../spotify/http';
import {createMlReadModule} from './reads';

const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const metrics:ModelMetrics={status:'insufficient_data',reason:'No feedback in this synthetic fixture.',
  modelVersion:'c1-r0-test',dataset:'user_feedback',evaluationMethod:'none',
  labeledExamples:0,trainedExamples:0,heldOutExamples:0,heldOutPositive:0,heldOutNegative:0,
  baseRate:null,balancedAccuracy:null,rocAuc:null,prAuc:null,logLoss:null,brierScore:null,
  precisionAtK:null,evaluatedAt:null};

async function setup(){
  const now=Date.parse('2026-11-07T12:00:00Z'),token='t'.repeat(43),userId='spotify:owner.test';
  const config=loadSpotifyConfig({SPOTIFY_CLIENT_ID:'test-client',SPOTIFY_ALLOWED_USER_IDS:'owner.test',
    TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),SESSION_SECRET:'s'.repeat(40)});
  const store=new TestStore(),cipher=new TokenCipher(config.encryptionKey);
  const auth=new AuthService(config,store,new SpotifyHttp({now:()=>now,fetch:async()=>{throw new Error('Read route must not call Spotify');}}));
  await store.transaction(async tx=>{
    await tx.putAccount({user:{id:userId,spotifyId:'owner.test',displayName:'Test listener',avatarUrl:null},
      accessToken:cipher.seal('synthetic-access',`${userId}:access`),refreshToken:cipher.seal('synthetic-refresh',`${userId}:refresh`),
      expiresAt:now-1,scopes:['user-library-read'],credentialVersion:crypto.randomUUID(),revoked:false,refreshLease:null});
    await tx.putSession({hash:sessionHash(token,config.sessionSecret),userId,expiresAt:now+10000});
  });
  const calls:string[]=[];
  const module=createMlReadModule({config,auth,
    ml:{evaluation:async user=>{calls.push(user);return metrics;}},
    getSummary:async user=>{calls.push(user);return {total:10,remaining:8,reviewed:2,kept:2,archived:0,unliked:0,skipped:0};},
    audioProgress:async user=>{calls.push(user);return {provider:'soundnet',status:'pending',featuresReady:0,featuresTotal:10,failed:0,missingness:{energy:1},reason:null};},
  });
  const app=await buildApp({config,registerRoutes:module.registerRoutes});apps.push(app);
  return {app,store,config,calls,userId,token,now,auth};
}

test('insights and analytics resolve the real stored session without refreshing expired provider credentials',async()=>{
  const {app,calls,userId,token}=await setup();
  for(const route of [PUBLIC_ROUTES.insights,PUBLIC_ROUTES.analytics]){
    const response=await app.inject({url:route.path,cookies:{sortfm_session:token}});
    expect(response.statusCode).toBe(200);
    expect(route.response.safeParse(response.json()).success).toBe(true);
    expect(response.body).not.toContain('synthetic-access');
    expect(response.body).not.toContain('synthetic-refresh');
  }
  expect(calls).toEqual([userId,userId,userId,userId]);
});

for(const invalidation of ['revoked','expired','disallowed'] as const){
  test(`real ${invalidation} sessions cannot read metrics or library counts`,async()=>{
    const {app,store,config,calls,userId,token,now}=await setup();
    await store.transaction(async tx=>{
      if(invalidation==='expired')await tx.putSession({hash:sessionHash(token,config.sessionSecret),userId,expiresAt:now});
      else {
        const account=(await tx.getAccount(userId))!;
        if(invalidation==='revoked')account.revoked=true;
        else account.user.spotifyId='different-owner';
        await tx.putAccount(account);
      }
    });
    for(const route of [PUBLIC_ROUTES.insights,PUBLIC_ROUTES.analytics]){
      const response=await app.inject({url:route.path,cookies:{sortfm_session:token}});
      expect(response.statusCode).toBe(invalidation==='disallowed'?403:401);
      expect(response.body).not.toContain(token);
    }
    expect(calls).toEqual([]);
  });
}
