import {test,expect} from 'bun:test';
import {SoundNetClient} from '../../../apps/api/src/jobs/soundnet/provider';
test.skipIf(!process.env.RUN_SLOW_SOUNDNET_TEST)('35-second mock provider does not block the core HTTP path',async()=>{
 const provider=Bun.serve({port:0,idleTimeout:60,fetch:async()=>{await Bun.sleep(35000);return Response.json({energy:75});}});
 const api=Bun.serve({port:0,fetch:()=>Response.json({ok:true})});
 try{
  const client=new SoundNetClient('test',{fetch:(_url,init)=>fetch(provider.url,init)});
  let finished=false;const slow=client.fetch('a'.repeat(22)).then(r=>{finished=true;return r;});
  const start=performance.now();expect((await fetch(api.url)).status).toBe(200);expect(performance.now()-start).toBeLessThan(1000);expect(finished).toBe(false);
  expect((await slow).raw).toEqual({energy:75});
 }finally{provider.stop(true);api.stop(true);}
},40000);
