import {test,expect} from 'bun:test';
import {SoundNetClient,ProviderError,retryDelay} from './provider';import {SoundNetWorker} from './worker';
import type {ClaimedJob,SoundNetQueue} from '../../../../../packages/db/src/soundnet-queue';
const id='a'.repeat(22);
test('provider validates IDs before network, honors Retry-After, masks response errors',async()=>{
 let calls=0;const client=new SoundNetClient('secret',{fetch:async()=>{calls++;return new Response('private error',{status:429,headers:{'Retry-After':'3'}});}});
 await expect(client.fetch('demo:bad')).rejects.toThrow('INVALID_TRACK_ID');expect(calls).toBe(0);
 try{await client.fetch(id);throw new Error('expected failure');}catch(e){expect(e).toBeInstanceOf(ProviderError);expect((e as ProviderError).retryAfterMs).toBe(3000);expect(String(e)).not.toContain('private');}
 expect(retryDelay(3,0,()=>0)).toBe(2000);expect(retryDelay(3,9000,()=>0)).toBe(9000);
});
test('slow provider times out and permanent failures do not retry',async()=>{
 const client=new SoundNetClient('secret',{timeoutMs:15,fetch:async(_url,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted'))))});
 await expect(client.fetch(id)).rejects.toMatchObject({code:'TIMEOUT',retryable:true});
 const terminal=new SoundNetClient('secret',{fetch:async()=>new Response('',{status:404})});await expect(terminal.fetch(id)).rejects.toMatchObject({code:'HTTP_404',retryable:false});
});
test('worker persists retry scheduling and global cooldown then caches normalized success',async()=>{
 const failures:unknown[][]=[];let cached:any;let paused=0;let count=0;
 const queue={maxAttempts:5,renew:async()=>true,dispatch:async(f:()=>Promise<unknown>)=>f(),complete:async(_j:unknown,v:unknown)=>{cached=v;return true;},fail:async(...v:unknown[])=>{failures.push(v);return true;},cooldown:async(ms:number)=>{paused=ms;}} as unknown as SoundNetQueue;
 const client=new SoundNetClient('secret',{fetch:async()=>++count===1?new Response('',{status:429,headers:{'Retry-After':'2'}}):Response.json({energy:42})});
 const worker=new SoundNetWorker(queue,client,{concurrency:3,maxConcurrency:5,random:()=>0});
 const job:ClaimedJob={trackId:id,featureVersion:'sortfm.features.v1',token:crypto.randomUUID(),attempts:1};
 await worker.process(job);expect(failures[0]!.slice(1,4)).toEqual(['HTTP_429',true,2000]);expect(paused).toBe(2000);expect(worker.concurrency).toBe(1);
 await worker.process({...job,attempts:2});expect(cached.normalized.values.energy).toBe(0.42);
});
test('bounded concurrent requests do not await slow audio on caller launch',async()=>{
 let claimed=0,active=0,maxActive=0,completed=0;const releases:(()=>void)[]=[];
 const queue={maxAttempts:5,claim:async()=>claimed<6?{trackId:id,featureVersion:'sortfm.features.v1',token:String(++claimed),attempts:1}:null,unfinished:async()=>6-completed,renew:async()=>true,dispatch:async(f:()=>Promise<unknown>)=>f(),complete:async()=>{completed++;return true;}} as unknown as SoundNetQueue;
 const client=new SoundNetClient('secret',{fetch:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise<void>(r=>releases.push(r));active--;return Response.json({energy:50});}});
 const worker=new SoundNetWorker(queue,client,{concurrency:3,maxConcurrency:3});const work=worker.run();
 await Bun.sleep(20);expect(active).toBe(3);expect(completed).toBe(0);
 releases.splice(0).forEach(r=>r());await Bun.sleep(20);releases.splice(0).forEach(r=>r());await work;
 expect(maxActive).toBe(3);expect(completed).toBe(6);
});
