import {expect,test} from 'bun:test';
import {PUBLIC_ROUTES} from '@sortfm/contracts';
import {buildApp} from '../app';
import {loadSpotifyConfig} from '../auth/config';
import {sessionHash,TokenCipher} from '../auth/crypto';
import {AuthService} from '../auth/service';
import {TestStore} from '../auth/test-support/store';
import {SpotifyHttp} from '../spotify/http';
import {createTasteConstellationModule} from './constellation';

test('real session ownership isolates constellation reads without provider refresh or other API capabilities',async()=>{
 const now=Date.parse('2026-11-08T12:00:00Z');
 const config=loadSpotifyConfig({SPOTIFY_CLIENT_ID:'test-client',SPOTIFY_ALLOWED_USER_IDS:'one,two',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),SESSION_SECRET:'s'.repeat(40)});
 const store=new TestStore(),cipher=new TokenCipher(config.encryptionKey);let providerCalls=0;
 const auth=new AuthService(config,store,new SpotifyHttp({now:()=>now,fetch:async()=>{providerCalls++;throw Error('Provider access forbidden');}}));
 for(const [index,name] of ['one','two'].entries())await store.transaction(async tx=>{
  const userId=`spotify:${name}`;
  await tx.putAccount({user:{id:userId,spotifyId:name,displayName:name,avatarUrl:null},accessToken:cipher.seal('private-access',`${userId}:access`),refreshToken:cipher.seal('private-refresh',`${userId}:refresh`),expiresAt:now-1,scopes:['user-library-read'],credentialVersion:crypto.randomUUID(),revoked:false,refreshLease:null});
  await tx.putSession({hash:sessionHash(String(index+1).repeat(43),config.sessionSecret),userId,expiresAt:now+10000});
 });
 const calls:string[]=[];
 const projection=new Proxy({constellation:async(userId:string)=>{calls.push(userId);return {userId,tracks:[{id:(userId==='spotify:one'?'1':'2').repeat(22),title:userId==='spotify:one'?'First owner track':'Second owner track',artist:'Synthetic artist',imageUrl:null,label:null,audio:{}}]};}},
  {get(target,key,receiver){if(key!=='constellation')throw Error('Unexpected capability');return Reflect.get(target,key,receiver);}});
 const module=createTasteConstellationModule({config,auth,projection});
 const app=await buildApp({config,registerRoutes:module.registerRoutes});
 try {
  for(const [index,expected,forbidden] of [[1,'First owner track','Second owner track'],[2,'Second owner track','First owner track']] as const){
   const response=await app.inject({url:PUBLIC_ROUTES.constellation.path,cookies:{sortfm_session:String(index).repeat(43)}});
   expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.body).toContain(expected);expect(response.body).not.toContain(forbidden);expect(response.body).not.toContain('private-');expect(response.body).not.toContain('spotify:');
  }
  await store.transaction(async tx=>{const account=(await tx.getAccount('spotify:one'))!;account.revoked=true;await tx.putAccount(account);});
  expect((await app.inject({url:PUBLIC_ROUTES.constellation.path,cookies:{sortfm_session:'1'.repeat(43)}})).statusCode).toBe(401);
  expect(calls).toEqual(['spotify:one','spotify:two']);expect(providerCalls).toBe(0);
 }finally{await app.close();}
});
