import {expect,test} from 'bun:test';
import {PLAYBACK_SDK_SCOPES} from '@sortfm/contracts';
import {pkceChallenge,TokenCipher} from '../auth/crypto';
import {owner,sessionToken} from './test-support';
import {fixture,config} from './fixtures';

test('separate exact-scope PKCE grants bind owner and browser; SDK token preserves expiry and never returns refresh/control',async()=>{
 const f=fixture();expect((await f.service.connection(sessionToken)).status).toBe('reconnect_required');
 const start=await f.connect(),url=new URL(start.authorizationUrl),exchange=new URLSearchParams(f.calls[0]!.init!.body as URLSearchParams);
 expect(pkceChallenge(exchange.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge')!);
 expect(url.searchParams.get('scope')!.split(' ')).toEqual([...PLAYBACK_SDK_SCOPES]);expect(url.searchParams.get('state')).toStartWith('playback-sdk.');
 expect((await f.service.connection(sessionToken))).toMatchObject({sdkReady:true,controlReady:false});
 expect((await f.connect()).purpose).toBe('control');expect((await f.service.connection(sessionToken)).status).toBe('ready');
 const first=await f.service.sdkToken(sessionToken);f.advance(1000);expect(await f.service.sdkToken(sessionToken)).toEqual(first);
 expect(first.accessToken).toBe('sdk-access');expect(JSON.stringify(first)).not.toContain('refresh');expect(first.scopes).toEqual([...PLAYBACK_SDK_SCOPES]);
 expect(JSON.stringify([...f.store.grants.values()])).not.toContain('sdk-access');expect(JSON.stringify([...f.store.grants.values()])).not.toContain('control-refresh');
 await expect(f.service.connect(sessionToken,{returnTo:'review'})).rejects.toMatchObject({statusCode:409});
});

test('broader, duplicate or missing initial scope evidence and wrong Spotify owner never publish a grant',async()=>{
 for(const scopes of [...PLAYBACK_SDK_SCOPES].map((_,i)=>PLAYBACK_SDK_SCOPES.slice(0,i).join(' ')).concat([PLAYBACK_SDK_SCOPES.join(' ')+' user-library-modify',PLAYBACK_SDK_SCOPES.join(' ')+' streaming'])){
  const f=fixture();f.setScope(scopes);await expect(f.connect()).rejects.toMatchObject({code:'PLAYBACK_SCOPE_REJECTED'});expect(f.store.grants.size).toBe(0);
 }
 const f=fixture();f.setProfile('foreign');await expect(f.connect()).rejects.toMatchObject({code:'ACCOUNT_NOT_ALLOWED'});expect(f.store.grants.size).toBe(0);
});

test('denial consumes state; bad browser, purpose, replay and logout cannot exchange or publish',async()=>{
 const f=fixture(),s=await f.service.connect(sessionToken,{returnTo:'review'}),state=new URL(s.authorizationUrl).searchParams.get('state')!;
 await expect(f.service.callback({state,code:'code'},'bad',sessionToken)).rejects.toThrow();expect(f.calls).toHaveLength(0);
 await expect(f.service.callback({state:state.replace('-sdk.','-control.'),code:'code'},s.browserToken,sessionToken)).rejects.toThrow();expect(f.calls).toHaveLength(0);
 await expect(f.service.callback({state,error:'access_denied'},s.browserToken,sessionToken)).rejects.toMatchObject({code:'OAUTH_ACCESS_DENIED'});
 await expect(f.service.callback({state,code:'code'},s.browserToken,sessionToken)).rejects.toThrow();expect(f.calls).toHaveLength(0);
 const g=fixture();g.intercept(async url=>{if(url.endsWith('/me')){g.store.live=false;return Response.json({id:'owner'});}return undefined;});
 await expect(g.connect()).rejects.toMatchObject({code:'AUTHENTICATION_REQUIRED'});expect(g.store.grants.size).toBe(0);
});

test('parallel expired token requests share one refresh; omitted scope/refresh retains only validated SDK grant',async()=>{
 const f=fixture();await f.connect();f.advance(3600000);let refreshes=0;
 f.intercept(async url=>{if(url.endsWith('/api/token')){refreshes++;await Bun.sleep(5);return Response.json({access_token:'sdk-new',token_type:'Bearer',expires_in:120});}return undefined;});
 const tokens=await Promise.all(Array.from({length:5},()=>f.service.sdkToken(sessionToken)));
 expect(refreshes).toBe(1);expect(tokens.every(t=>t.accessToken==='sdk-new')).toBe(true);
 expect(tokens[0]!.scopes).toEqual([...PLAYBACK_SDK_SCOPES]);
 const g=f.store.grants.get(`${owner}:sdk`)!;expect(new TokenCipher(config.encryptionKey).open(g.encryptedRefreshToken,`${owner}:playback:sdk:refresh`)).toBe('sdk-refresh');
});

test('rejected refresh scopes revoke only the fenced SDK grant; newer consent survives a late rejection',async()=>{
 const f=fixture();await f.connect();await f.connect();f.advance(3600000);
 f.intercept(async url=>url.endsWith('/api/token')?Response.json({access_token:'broad',token_type:'Bearer',expires_in:3600,scope:'streaming user-read-email user-read-private user-library-modify'}):undefined);
 await expect(f.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'PLAYBACK_SCOPE_REJECTED'});
 expect(f.store.grants.get(`${owner}:sdk`)!.revoked).toBe(true);expect(f.store.grants.get(`${owner}:control`)!.revoked).toBe(false);expect(f.store.live).toBe(true);
 const g=fixture();await g.connect();g.advance(3600000);
 g.intercept(async url=>{if(!url.endsWith('/api/token'))return undefined;const next=structuredClone(g.store.grants.get(`${owner}:sdk`)!);next.credentialVersion=crypto.randomUUID();next.expiresAt=g.transport.now()+3600000;next.refreshLease=null;g.store.grants.set(`${owner}:sdk`,next);return Response.json({error:'invalid_grant'},{status:400});});
 await expect(g.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'PLAYBACK_RECONNECT_REQUIRED'});expect(g.store.grants.get(`${owner}:sdk`)!.revoked).toBe(false);
});

test('logout during refresh fences publication and token delivery; ambiguous exchange never retries',async()=>{
 const f=fixture();await f.connect();f.advance(3600000);let calls=0;
 f.intercept(async url=>{if(!url.endsWith('/api/token'))return undefined;calls++;f.store.live=false;return Response.json({access_token:'late',expires_in:3600,token_type:'Bearer'});});
 await expect(f.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'AUTHENTICATION_REQUIRED'});expect(calls).toBe(1);
 const g=fixture();await g.connect();g.advance(3600000);let failures=0;g.intercept(async url=>{if(url.endsWith('/api/token')){failures++;throw Error('refresh-secret');}return undefined;});
 await expect(g.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'PLAYBACK_OUTCOME_UNKNOWN'});expect(failures).toBe(1);expect(g.store.grants.get(`${owner}:sdk`)!.revoked).toBe(true);
});

test('a newly refreshed short-lived token is issued once while unexpired; no refresh loop',async()=>{
 const f=fixture();await f.connect();f.advance(3600000);let refreshes=0;
 f.intercept(async url=>{if(!url.endsWith('/api/token'))return undefined;refreshes++;return Response.json({access_token:'short-token',token_type:'Bearer',expires_in:30});});
 expect((await f.service.sdkToken(sessionToken)).accessToken).toBe('short-token');expect(refreshes).toBe(1);
});
test('rate limit after a successful rotating refresh never retains the old refresh credential',async()=>{
 const f=fixture();await f.connect();f.advance(3600000);let refreshes=0;
 f.intercept(async url=>{if(url.endsWith('/api/token')){refreshes++;return Response.json({access_token:'new',refresh_token:'rotated',token_type:'Bearer',expires_in:3600});}return Response.json({error:{}},{status:429,headers:{'Retry-After':'5'}});});
 await expect(f.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'PLAYBACK_RATE_LIMITED'});
 expect(f.store.grants.get(`${owner}:sdk`)!.revoked).toBe(true);expect(refreshes).toBe(1);
});

test('initial grant needs explicit scope evidence and unexpired credentials before publication',async()=>{
 const f=fixture();f.intercept(async url=>url.endsWith('/api/token')?Response.json({access_token:'access',refresh_token:'refresh',token_type:'Bearer',expires_in:3600}):undefined);
 await expect(f.connect()).rejects.toMatchObject({code:'PLAYBACK_SCOPE_REJECTED'});expect(f.store.grants.size).toBe(0);
 const g=fixture();g.intercept(async url=>{if(url.endsWith('/api/token'))return Response.json({access_token:'access',refresh_token:'refresh',token_type:'Bearer',expires_in:1,scope:PLAYBACK_SDK_SCOPES.join(' ')});g.advance(2000);return Response.json({id:'owner'});});
 await expect(g.connect()).rejects.toMatchObject({code:'PLAYBACK_RECONNECT_REQUIRED'});expect(g.store.grants.size).toBe(0);
});
test('definite token429 preserves the original grant and exposes a bounded retry deadline without replay',async()=>{
 const f=fixture();await f.connect();f.advance(3600000);let calls=0;
 f.intercept(async url=>{if(!url.endsWith('/api/token'))return undefined;calls++;return new Response(null,{status:429,headers:{'Retry-After':'5'}});});
 await expect(f.service.sdkToken(sessionToken)).rejects.toMatchObject({code:'PLAYBACK_RATE_LIMITED',retryAt:f.transport.now()+5000});
 const grant=f.store.grants.get(`${owner}:sdk`)!;expect(grant.revoked).toBe(false);expect(grant.refreshLease).toBeNull();expect(calls).toBe(1);
});
test('cached SDK issuance fences logout and version change during profile verification',async()=>{
 for(const change of ['logout','version']){
  const f=fixture();await f.connect();f.intercept(async()=>{if(change==='logout')f.store.live=false;else f.store.grants.get(`${owner}:sdk`)!.credentialVersion=crypto.randomUUID();return Response.json({id:'owner'});});
  await expect(f.service.sdkToken(sessionToken)).rejects.toMatchObject({code:change==='logout'?'AUTHENTICATION_REQUIRED':'PLAYBACK_UNAVAILABLE'});
 }
});
