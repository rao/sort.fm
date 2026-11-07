import {expect,test} from 'bun:test';
import {selectPrewarmTrackIds,readPrewarmPriority,type PrewarmPrioritySnapshot,type RecentPrewarmExposure} from './prewarm';
import {CalibrationQueue} from './queue';
import {fixture,now,owner,row} from './test-fixtures';
const id=(n:number)=>row(n).track.trackId;
function snapshot():PrewarmPrioritySnapshot {
 const library=Array.from({length:80},(_,i)=>row(i+1));
 return {userId:owner,library,eligibleTrackIds:library.map(r=>r.track.trackId),recentExposures:[]};
}
function exposure(n:number,position:number,age=1000):RecentPrewarmExposure {
 return {exposureId:crypto.randomUUID(),trackId:id(n),purpose:'calibration',servedAt:new Date(now-age).toISOString(),position,consumed:false};
}

test('prioritizes newest batches, preserves batch positions and deduplicates tracks before diverse fill',()=>{
 const s=snapshot();s.recentExposures=[exposure(4,0,2000),exposure(3,2),exposure(2,1),exposure(1,0),exposure(1,1,2000)];
 const before=structuredClone(s),selected=selectPrewarmTrackIds(owner,s,{now});
 expect(selected.slice(0,4)).toEqual([id(1),id(2),id(3),id(4)]);
 expect(selected).toHaveLength(25);expect(new Set(selected).size).toBe(25);expect(s).toEqual(before);
 expect(selectPrewarmTrackIds(owner,{...s,library:[...s.library].reverse(),recentExposures:[...s.recentExposures].reverse()},{now})).toEqual(selected);
});

test('uses exactly the existing calibration order as fallback without scoring or inserting exposures',async()=>{
 const s=snapshot(),f=fixture(s.library),page=await new CalibrationQueue(f.store,{now:()=>now}).get(owner,{limit:50});
 const order=page.items.map(i=>i.track.trackId);
 expect(selectPrewarmTrackIds(owner,s,{now})).toEqual(order.slice(0,25));
 s.recentExposures=[{...exposure(1,0),trackId:order[10]!},{...exposure(2,1),trackId:order[40]!}];
 expect(selectPrewarmTrackIds(owner,s,{now})).toEqual([order[10]!,order[40]!,...order.filter(id=>id!==order[10]&&id!==order[40]).slice(0,23)]);
});

test('excludes consumed, expired, future and non-authoritative recent tracks; limits remain hard bounded',()=>{
 const s=snapshot();s.eligibleTrackIds=s.eligibleTrackIds.filter(t=>t!==id(1));
 s.recentExposures=[exposure(1,0),{...exposure(2,1),consumed:true},exposure(3,2,30*60*1000+1),exposure(4,3,-1),exposure(5,4)];
 expect(selectPrewarmTrackIds(owner,s,{now,limit:1})).toEqual([id(5)]);
 expect(selectPrewarmTrackIds(owner,s,{now})).not.toContain(id(1));
 for(const limit of [0,26,-1,1.5,Infinity])expect(()=>selectPrewarmTrackIds(owner,s,{now,limit})).toThrow();
 for(const recentWindowMs of [0,-1,86400001,Infinity])expect(()=>selectPrewarmTrackIds(owner,s,{now,recentWindowMs})).toThrow();
 expect(()=>selectPrewarmTrackIds(owner,s,{now:NaN})).toThrow();
});

test('filters changed status, unplayable, pending and completed tracks even if advisory IDs are stale',()=>{
 const s=snapshot();s.library[0]!.currentStatus='unliked';s.library[1]!.track.isPlayable=false;
 s.library[2]!.currentDecision={status:'PENDING'} as never;s.library[3]!.currentDecision={status:'COMPLETE'} as never;
 s.recentExposures=[exposure(1,0),exposure(2,1),exposure(3,2),exposure(4,3),exposure(5,4)];
 const selected=selectPrewarmTrackIds(owner,s,{now});expect(selected[0]).toBe(id(5));
 for(let n=1;n<=4;n++)expect(selected).not.toContain(id(n));
});

test('fails closed on owner, identity or bounds corruption; empty eligibility exports no IDs',()=>{
 const s=snapshot();
 expect(()=>selectPrewarmTrackIds('spotify:foreign',s,{now})).toThrow();
 expect(()=>selectPrewarmTrackIds(owner,{...s,eligibleTrackIds:[id(999)]},{now})).toThrow();
 expect(()=>selectPrewarmTrackIds(owner,{...s,eligibleTrackIds:[id(1),id(1)]},{now})).toThrow();
 expect(()=>selectPrewarmTrackIds(owner,{...s,library:[...s.library,s.library[0]!]},{now})).toThrow();
 const e=exposure(1,0);expect(()=>selectPrewarmTrackIds(owner,{...s,recentExposures:[e,e]},{now})).toThrow();
 expect(()=>selectPrewarmTrackIds(owner,{...s,recentExposures:Array.from({length:251},()=>exposure(1,0))},{now})).toThrow();
 expect(selectPrewarmTrackIds(owner,{...s,eligibleTrackIds:[]},{now})).toEqual([]);
});

test('read-only adapter calls one bounded snapshot read and rejects invalid options before reading',async()=>{
 let calls=0;const s=snapshot(),port={readPrewarmSnapshot:async(userId:string,query:{since:string;limit:number})=>{
  calls++;expect(userId).toBe(owner);expect(query).toEqual({since:new Date(now-30*60*1000).toISOString(),limit:250});return s;
 }};
 const original=globalThis.fetch;globalThis.fetch=Object.assign(async()=>{throw Error('No network');},{preconnect:original.preconnect}) as typeof fetch;
 try{
  expect(await readPrewarmPriority(port,owner,{now})).toHaveLength(25);expect(calls).toBe(1);
  await expect(readPrewarmPriority(port,owner,{now,limit:26})).rejects.toThrow();expect(calls).toBe(1);
 }finally{globalThis.fetch=original;}
});

test('bounds recent-first results on a full 2768-track fixture and preserves purpose batch positions',()=>{
 const library=Array.from({length:2768},(_,i)=>row(i+1));
 const s:PrewarmPrioritySnapshot={userId:owner,library,eligibleTrackIds:library.map(r=>r.track.trackId),recentExposures:
  Array.from({length:30},(_,i)=>({...exposure(i+1,i%15),purpose:i<15?'review' as const:'calibration' as const})).reverse()};
 const selected=selectPrewarmTrackIds(owner,s,{now});
 expect(selected).toEqual([...Array.from({length:15},(_,i)=>id(i+16)),...Array.from({length:10},(_,i)=>id(i+1))]);
 expect(selected).toHaveLength(25);
});
