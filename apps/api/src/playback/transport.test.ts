import {expect,test} from 'bun:test';
import {PlaybackTransport} from './transport';

test('provider writes are one attempt, explicit target, sanitized and never redirect or replay',async()=>{
 for(const status of [401,403,404,429,500]){
  let calls=0;const transport=new PlaybackTransport({now:()=>1000,fetch:async(_url,init)=>{calls++;expect(init?.redirect).toBe('error');return Response.json({error:{message:'secret-access',reason:status===403?'PREMIUM_REQUIRED':'bad'}},{status,headers:{'Retry-After':'3'}});}});
  try{await transport.api('/me/player/play?device_id=device','secret-access',{method:'PUT',body:{uris:['spotify:track:0000000000000000000001']}});throw Error('expected rejection');}
  catch(error:any){expect(error.message).not.toContain('secret-access');expect(error.retryable).toBe(false);expect(error.statusCode).toBe(status===500?503:status===404?409:status);}
  expect(calls).toBe(1);
 }
});
test('timeouts, malformed success and network failure never expose provider content or retry writes',async()=>{
 for(const fetcher of [async()=>{throw Error('Bearer secret');},async()=>new Response('secret invalid JSON'),async()=>new Promise<Response>(()=>{})]){
  let calls=0;const transport=new PlaybackTransport({timeoutMs:5,fetch:async()=>{calls++;return fetcher();}});
  await expect(transport.api('/me/player','secret',{method:'PUT',body:{device_ids:['device'],play:false}})).rejects.toMatchObject({code:'PLAYBACK_OUTCOME_UNKNOWN',retryable:false});expect(calls).toBe(1);
 }
});
test('204 playback and token errors are interpreted without raw provider bodies',async()=>{
 const empty=new PlaybackTransport({fetch:async()=>new Response(null,{status:204})});expect(await empty.api('/me/player','token')).toBeNull();
 const bad=new PlaybackTransport({fetch:async()=>Response.json({error:'invalid_grant',error_description:'refresh-secret'},{status:400})});
 await expect(bad.token(new URLSearchParams())).rejects.toMatchObject({code:'PLAYBACK_RECONNECT_REQUIRED'});
});
test('provider deadline cannot consume the fenced refresh lease budget',()=>{
 expect(()=>new PlaybackTransport({timeoutMs:20001})).toThrow();
});
