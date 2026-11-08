import {describe, expect, test} from 'bun:test';
import {ListeningContextSnapshotSchema, type TasteContext} from '@sortfm/contracts';
import {demoTracks} from '@sortfm/contracts/fixtures';
import {assembleLibraryCandidatesWithListeningContext, type MlLibraryRow} from './features';
import {prepareListeningContext, readCachedTasteContext} from './listening-context';

const now='2026-11-07T12:00:00.000Z', userId='spotify:example.listener';
const first='0000000000000000000001', second='0000000000000000000002';
const options={userId,now};
function context(overrides:Partial<TasteContext>={}):TasteContext {
  return {userId,fetchedAt:'2026-11-07T11:00:00.000Z',source:'spotify-recently-played',completeHistory:false,error:null,
    events:[{trackId:first,playedAt:'2026-11-07T10:00:00.000Z'}],...overrides};
}
function rows():MlLibraryRow[] {
  return [first,second].map((trackId,i)=>({track:{...structuredClone(demoTracks[i]!),trackId,source:'spotify' as const,
    spotifyUri:`spotify:track:${trackId}`},currentStatus:'saved',audioFeatures:null,currentDecision:null}));
}

describe('validated cached listening context',()=>{
  test('retains truthful incomplete sample coverage while normalizing duplicate instants',()=>{
    const raw=context({events:[
      {trackId:first,playedAt:'2026-11-07T10:00:00.000Z'},
      {trackId:first,playedAt:'2026-11-07T05:00:00-05:00'},
      {trackId:first,playedAt:'2026-11-06T10:00:00Z'},
      {trackId:second,playedAt:'2026-10-01T10:00:00Z'},
    ]}),before=structuredClone(raw);
    const result=prepareListeningContext(raw,options);
    expect(result.listeningContext).toEqual({source:'spotify-recently-played',status:'fresh',
      completeHistory:false,fetchedAt:'2026-11-07T11:00:00.000Z',asOf:now,ageMs:3_600_000,
      cachedEventCount:4,uniqueEventCount:3,windowEventCount:2,sampleLimit:50,windowStart:'2026-10-08T12:00:00.000Z'});
    expect(result.tasteContext?.events).toEqual([
      {trackId:first,playedAt:'2026-11-06T10:00:00.000Z'},
      {trackId:first,playedAt:'2026-11-07T10:00:00.000Z'},
    ]);
    expect(raw).toEqual(before);
    expect(ListeningContextSnapshotSchema.safeParse(result.listeningContext).success).toBe(true);
    expect(result.tasteContext).not.toBe(raw);
  });

  test('fresh empty observation has zero sample counts without implying observed per-track zero plays',()=>{
    const result=prepareListeningContext(context({events:[]}),options);
    expect(result.listeningContext).toMatchObject({status:'fresh',cachedEventCount:0,uniqueEventCount:0,windowEventCount:0});
    expect(result.tasteContext?.events).toEqual([]);
  });

  test.each([
    [null,'missing'],
    [undefined,'missing'],
    [context({userId:'spotify:someone.else'}),'owner_mismatch'],
    [context({fetchedAt:'yesterday'}),'invalid'],
    [{...context(),events:null},'invalid'],
    [{...context(),completeHistory:true},'invalid'],
    [{...context(),source:'spotify-top-tracks'},'invalid'],
    [{...context(),events:[{trackId:'demo:one',playedAt:now}]},'invalid'],
    [{...context(),events:[{trackId:first,playedAt:'2026-02-30T12:00:00Z'}]},'invalid'],
    [{...context(),events:[{trackId:first,playedAt:'2026-11-07T10:00:00'}]},'invalid'],
    [{...context(),events:Array.from({length:51},()=>({trackId:first,playedAt:now}))},'invalid'],
  ] as const)('quarantines absent, mismatched or malformed context %#', (raw,status)=>{
    const result=prepareListeningContext(raw,options);
    expect(result.tasteContext).toBeNull();
    expect(result.listeningContext).toMatchObject({status,fetchedAt:null,ageMs:null,
      cachedEventCount:null,uniqueEventCount:null,windowEventCount:null});
    expect(JSON.stringify(result)).not.toContain('someone.else');
    expect(ListeningContextSnapshotSchema.safeParse(result.listeningContext).success).toBe(true);
  });

  test.each([
    [context({fetchedAt:'2026-11-06T11:59:59.999Z',events:[]}),'stale',86_400_001],
    [context({fetchedAt:'2026-11-07T12:00:00.001Z',events:[]}),'future',null],
    [context({events:[{trackId:first,playedAt:'2026-11-07T11:00:00.001Z'}]}),'future',3_600_000],
    [context({error:{code:'PROVIDER_FAILED',message:'private transport details',retryable:true}}),'provider_error',3_600_000],
  ] as const)('retains only verified own freshness metadata when sample is unusable %#',(raw,status,ageMs)=>{
    const result=prepareListeningContext(raw,options);
    expect(result.tasteContext).toBeNull();
    expect(result.listeningContext).toMatchObject({status,fetchedAt:raw.fetchedAt,ageMs,
      cachedEventCount:raw.events.length,uniqueEventCount:null,windowEventCount:null});
    expect(JSON.stringify(result)).not.toContain('private transport details');
    expect(ListeningContextSnapshotSchema.safeParse(result.listeningContext).success).toBe(true);
  });

  test('freshness and event inclusion boundaries are inclusive and normalized by timestamp instant',()=>{
    const result=prepareListeningContext(context({fetchedAt:'2026-11-06T07:00:00-05:00',events:[
      {trackId:first,playedAt:'2026-10-08T12:00:00.000Z'},
      {trackId:second,playedAt:'2026-10-08T11:59:59.999Z'},
    ]}),options);
    expect(result.listeningContext).toMatchObject({status:'fresh',ageMs:86_400_000,cachedEventCount:2,uniqueEventCount:2,windowEventCount:1});
    expect(result.tasteContext?.events).toEqual([{trackId:first,playedAt:'2026-10-08T12:00:00.000Z'}]);
  });

  test('owner mismatch cannot leak even valid freshness or sample metadata',()=>{
    const result=prepareListeningContext(context({userId:'spotify:someone.else',fetchedAt:'2026-11-07T09:12:34Z'}),options);
    expect(result.listeningContext.fetchedAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('09:12:34');
    expect(JSON.stringify(result)).not.toContain(first);
  });

  test('cache read failure has safe missing context, without retry or error contents',async()=>{
    let calls=0;
    const result=await readCachedTasteContext({async getTasteContext(owner){calls++;expect(owner).toBe(userId);throw Error('private DB connection string');}},options);
    expect(calls).toBe(1);
    expect(result.tasteContext).toBeNull();
    expect(result.listeningContext).toMatchObject({status:'read_error',fetchedAt:null,ageMs:null,cachedEventCount:null});
    expect(JSON.stringify(result)).not.toContain('private DB');
  });

  test('rejects invalid caller owner or clock before cache access',async()=>{
    let calls=0;
    const reader={async getTasteContext(){calls++;return context();}};
    await expect(readCachedTasteContext(reader,{...options,userId:'other/user'})).rejects.toThrow();
    await expect(readCachedTasteContext(reader,{...options,now:'not-time'})).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('freezes the owner and exposure instant before awaiting a cache read',async()=>{
    const mutable={...options};
    const pending=readCachedTasteContext({async getTasteContext(){
      mutable.userId='spotify:other';mutable.now='2026-11-09T12:00:00Z';
      return context();
    }},mutable);
    const result=await pending;
    expect(result.listeningContext).toMatchObject({status:'fresh',asOf:now,ageMs:3_600_000});
    expect(result.tasteContext?.userId).toBe(userId);
  });

  test('a timed-out cache read returns missing features and never adopts a late result',async()=>{
    let complete!:(value:TasteContext)=>void,calls=0;
    const delayed=new Promise<TasteContext>(resolve=>{complete=resolve;});
    const result=await readCachedTasteContext({getTasteContext(){calls++;return delayed;}},{...options,cacheReadTimeoutMs:10});
    expect(result.listeningContext.status).toBe('read_error');
    expect(result.tasteContext).toBeNull();
    const before=structuredClone(result);
    complete(context());await delayed;
    expect(result).toEqual(before);expect(calls).toBe(1);
  },1000);

  test('late cache rejection after timeout remains handled and is never retried',async()=>{
    let rejectLate!:(error:Error)=>void,calls=0;
    const delayed=new Promise<unknown>((_,reject)=>{rejectLate=reject;});
    const result=await readCachedTasteContext({getTasteContext(){calls++;return delayed;}},{...options,cacheReadTimeoutMs:10});
    rejectLate(Error('private read failure'));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(result.listeningContext.status).toBe('read_error');expect(calls).toBe(1);
    expect(ListeningContextSnapshotSchema.safeParse(result.listeningContext).success).toBe(true);
  },1000);

  test.each([0,-1,1.5,Number.NaN,Number.POSITIVE_INFINITY,60_001])('rejects invalid read deadline %s before cache access',async cacheReadTimeoutMs=>{
    let calls=0;
    await expect(readCachedTasteContext({async getTasteContext(){calls++;return context();}},{...options,cacheReadTimeoutMs})).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test('async assembler reads once, freezes the supplied instant, returns coverage beside unchanged feature schema',async()=>{
    const library=rows(),cached=context(),before=structuredClone({library,cached});
    let calls=0;
    const result=await assembleLibraryCandidatesWithListeningContext(library,{...options,
      metadataTraining:{permittedForTraining:true,rightsBasis:'Authored fixture authorization'}},
    {async getTasteContext(owner){calls++;expect(owner).toBe(userId);return cached;}});
    expect(calls).toBe(1);
    expect(result.candidates.map(c=>c.features.values.recent_play_count)).toEqual([1,undefined]);
    expect(result.candidates.every(c=>c.features.permittedForTraining)).toBe(true);
    expect(result.candidates.every(c=>!Object.hasOwn(c.features,'listeningContext'))).toBe(true);
    expect(result.listeningContext).toMatchObject({status:'fresh',asOf:now,cachedEventCount:1});
    expect({library,cached}).toEqual(before);
    cached.events.push({trackId:second,playedAt:'2026-11-07T09:00:00Z'});
    expect(result.candidates[1]!.features.values.recent_play_count).toBeUndefined();
    expect(result.listeningContext.cachedEventCount).toBe(1);
  });

  test('async cache failure preserves metadata and audio inference without listening zeros',async()=>{
    const result=await assembleLibraryCandidatesWithListeningContext(rows(),options,{async getTasteContext(){throw Error('offline');}});
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.every(c=>c.features.values.duration_ms!==undefined)).toBe(true);
    expect(result.candidates.every(c=>c.features.values.recent_play_count===undefined)).toBe(true);
    expect(result.listeningContext.status).toBe('read_error');
  });

  test('async assembly preserves original exposure clock and permission while the read is pending',async()=>{
    const mutable={...options,metadataTraining:{permittedForTraining:true,rightsBasis:'Authored fixture authorization'}};
    const result=await assembleLibraryCandidatesWithListeningContext(rows(),mutable,{async getTasteContext(){
      mutable.now='2026-11-09T12:00:00Z';mutable.metadataTraining.permittedForTraining=false;
      return context();
    }});
    expect(result.listeningContext.asOf).toBe(now);
    expect(result.candidates.every(c=>c.features.permittedForTraining)).toBe(true);
    expect(result.candidates[0]!.features.values.recent_play_count).toBe(1);
  });
});
