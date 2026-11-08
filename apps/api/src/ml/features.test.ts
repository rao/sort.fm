import {describe,expect,test} from 'bun:test';
import {FeatureVectorSchema,FEATURE_VERSION,type TasteContext,type FeatureVector} from '@sortfm/contracts';
import {demoTracks} from '@sortfm/contracts/fixtures';
import {assembleLibraryCandidates,feedbackSplit,type MlLibraryRow} from './features';

const now='2026-11-07T12:00:00.000Z';
const options={userId:'user:1',now,metadataTraining:{permittedForTraining:true,rightsBasis:'Test fixture authorization'}};
function row(index=0):MlLibraryRow { return {track:structuredClone(demoTracks[index]!),currentStatus:'saved',audioFeatures:null,currentDecision:null}; }
function audio(values:FeatureVector['values']):FeatureVector{return {featureVersion:FEATURE_VERSION,values,provenance:'synthetic',permittedForTraining:true,rightsBasis:'Original test values'};}

describe('library feature assembly',()=>{
 test('metadata-only preserves identities, zeros, unknown history, and no derived label data',()=>{
  const one=row();one.track.originalAddedAt='2026-11-06T12:00:00.000Z';one.track.durationMs=0;
  const candidates=assembleLibraryCandidates([one],options); const c=candidates[0]!;
  expect(c.trackId).toBe(one.track.trackId);expect(c.exposureId).toBeUndefined();
  expect(c.features.values.saved_age_days).toBe(1);expect(c.features.values.duration_ms).toBe(0);
  expect(c.features.values.release_age_years).toBe(8);expect(c.features.values.artist_library_count).toBe(1);
  expect(c.features.values.recent_play_count).toBeUndefined();expect(c.features.values.top_track_long).toBeUndefined();
  expect(c.features.values.kept_centroid_distance).toBeUndefined();expect(c.features.permittedForTraining).toBe(true);
  expect(FeatureVectorSchema.safeParse(c.features).success).toBe(true);
 });
 test('artist counts use full distinct track library and never mutate inputs',()=>{
  const rows=[row(0),row(10),row(1)];const before=structuredClone(rows);
  expect(assembleLibraryCandidates(rows,options).map(c=>c.features.values.artist_library_count)).toEqual([2,2,1]);
  expect(rows).toEqual(before);
 });
 test('partial permitted audio retains zero but cannot override metadata or inject label distances',()=>{
  const one=row();one.audioFeatures=audio({energy:0,tempo_bpm:123,loudness_db:null,duration_ms:1,saved_age_days:0,kept_centroid_distance:0});
  const values=assembleLibraryCandidates([one],options)[0]!.features.values;
  expect(values.energy).toBe(0);expect(values.tempo_bpm).toBe(123);expect(values.loudness_db).toBeNull();
  expect(values.duration_ms).toBe(one.track.durationMs);expect(values.saved_age_days).toBeGreaterThan(0);
  expect(values.kept_centroid_distance).toBeUndefined();
 });
 test('unpermitted audio is omitted without disabling permitted metadata feedback',()=>{
  const one=row();one.audioFeatures={...audio({energy:.8}),permittedForTraining:false};
  const f=assembleLibraryCandidates([one],options)[0]!.features;
  expect(f.values.energy).toBeUndefined();expect(f.permittedForTraining).toBe(true);
 });
 test('bad numeric audio degrades field-by-field, wrong version becomes metadata only',()=>{
  const one=row();one.audioFeatures=audio({energy:100,tempo_bpm:123,loudness_db:Number.NaN});
  const values=assembleLibraryCandidates([one],options)[0]!.features.values;
  expect(values.energy).toBeNull();expect(values.tempo_bpm).toBe(123);expect(values.loudness_db).toBeNull();
  one.audioFeatures.featureVersion='wrong' as typeof FEATURE_VERSION;
  expect(assembleLibraryCandidates([one],options)[0]!.features.values.tempo_bpm).toBeUndefined();
 });
 test('review outcome and current status never become predictor features',()=>{
  const one=row();const before=assembleLibraryCandidates([one],options);
  one.currentStatus='archived';one.currentDecision={label:1} as MlLibraryRow['currentDecision'];
  expect(assembleLibraryCandidates([one],options)).toEqual(before);
 });
 test('requires explicit permission but never labels or blocks inference',()=>{
  expect(assembleLibraryCandidates([row()],{userId:'user:1',now})[0]!.features.permittedForTraining).toBe(false);
 });
 test('duplicate tracks and invalid clock rejected',()=>{
  expect(()=>assembleLibraryCandidates([row(),row()],options)).toThrow('DUPLICATE_TRACK');
  expect(()=>assembleLibraryCandidates([row()],{...options,now:'bad'})).toThrow();
 });
 test('recent count reflects fresh limited observations and foreign-owner context stays missing',()=>{
  const one=spotifyRow();
  const context:TasteContext={userId:'user:1',fetchedAt:now,source:'spotify-recently-played',completeHistory:false,error:null,
    events:[{trackId:one.track.trackId,playedAt:'2026-11-06T12:00:00Z'},
      {trackId:one.track.trackId,playedAt:'2026-08-01T12:00:00Z'}]};
  expect(assembleLibraryCandidates([one],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBe(1);
  expect(assembleLibraryCandidates([one],{...options,tasteContext:{...context,fetchedAt:'2026-11-01T12:00:00Z'}})[0]!.features.values.recent_play_count).toBeUndefined();
  expect(assembleLibraryCandidates([one],{...options,tasteContext:{...context,userId:'other'}})).toEqual(assembleLibraryCandidates([one],options));
 });
 test('real metadata plus approved SoundNet preserves provenance and rights basis',()=>{
  const one=row();one.track.trackId='4uLU6hMCjMI75M1A2tKUQC';one.track.source='spotify';one.track.spotifyUri=`spotify:track:${one.track.trackId}`;
  one.audioFeatures={...audio({energy:.5}),provenance:'soundnet'};
  const f=assembleLibraryCandidates([one],options)[0]!.features;
  expect(f.provenance).toBe('soundnet');expect(f.rightsBasis).toContain('Test fixture authorization');expect(f.rightsBasis).toContain('Original test values');
 });
 test('Musicae partial audio reaches real-track scoring without filling missing happiness or popularity',()=>{
  const one=row();one.track.trackId='0000000000000000000001';one.track.source='spotify';one.track.spotifyUri=`spotify:track:${one.track.trackId}`;
  one.audioFeatures={...audio({energy:0,tempo_bpm:123,loudness_db:null,mode_major:0}),provenance:'musicae'};
  const before=structuredClone(one),f=assembleLibraryCandidates([one],options)[0]!.features;
  expect(f.provenance).toBe('musicae');expect(f.values.energy).toBe(0);expect(f.values.tempo_bpm).toBe(123);expect(f.values.mode_major).toBe(0);
  expect(f.values.loudness_db).toBeNull();expect(f.values.happiness).toBeUndefined();expect(f.values.soundnet_popularity).toBeUndefined();
  expect(f.rightsBasis).toContain('Original test values');expect(f.permittedForTraining).toBe(true);expect(one).toEqual(before);
 });
 test('Musicae observations retain field validation and cannot alias valence into happiness',()=>{
  const one=row();one.track.trackId='0000000000000000000001';one.track.source='spotify';one.track.spotifyUri=`spotify:track:${one.track.trackId}`;
  one.audioFeatures={...audio({energy:80,tempo_bpm:123,happiness:null,soundnet_popularity:null}),provenance:'musicae'};
  Object.assign(one.audioFeatures.values,{valence:0.9,popularity:0.9});
  const f=assembleLibraryCandidates([one],options)[0]!.features;
  expect(f.provenance).toBe('musicae');expect(f.values.energy).toBeNull();expect(f.values.tempo_bpm).toBe(123);
  expect(f.values.happiness).toBeNull();expect(f.values.soundnet_popularity).toBeNull();expect(f.values).not.toHaveProperty('valence');expect(f.values).not.toHaveProperty('popularity');
  one.audioFeatures.permittedForTraining=false;
  expect(assembleLibraryCandidates([one],options)[0]!.features.provenance).toBe('spotify');
  expect(assembleLibraryCandidates([one],options)[0]!.features.values.tempo_bpm).toBeUndefined();
 });
});

test('feedback split matches Python SHA256 compact tuple fixtures',()=>{
 expect(Array.from({length:12},(_,i)=>feedbackSplit('demo:user',`demo:${i}`,42))).toEqual(SPLIT_EXPECTED);
 expect(feedbackSplit('demo:user','demo:one',-1)).toBe(feedbackSplit('demo:user','demo:one',-1));
 expect(()=>feedbackSplit('bad/user','demo:one')).toThrow();
});
const SPLIT_EXPECTED:('train'|'holdout')[]=['train','train','holdout','train','train','train','train','holdout','holdout','train','train','train'];

const recentTrackA='0000000000000000000001';
const recentTrackB='0000000000000000000002';
function spotifyRow(trackId=recentTrackA):MlLibraryRow {
 const one=row();one.track.trackId=trackId;one.track.source='spotify';one.track.spotifyUri=`spotify:track:${trackId}`;return one;
}
function recentContext(events:TasteContext['events']):TasteContext {
 return {userId:options.userId,fetchedAt:now,source:'spotify-recently-played',completeHistory:false,error:null,events};
}

describe('incomplete cached listening observations',()=>{
 test('an unmatched track stays missing rather than receiving an invented zero',()=>{
  const context=recentContext([{trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'}]);
  const result=assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:context});
  expect(result.map(candidate=>candidate.features.values.recent_play_count)).toEqual([1,undefined]);
 });
 test('offset-equivalent copies of one play count only once',()=>{
  const context=recentContext([
   {trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'},
   {trackId:recentTrackA,playedAt:'2026-11-06T07:00:00-05:00'},
  ]);
  expect(assembleLibraryCandidates([spotifyRow()],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBe(1);
 });
 test('different play times remain distinct and the same instant can count once for each track',()=>{
  const context=recentContext([
   {trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'},
   {trackId:recentTrackA,playedAt:'2026-11-06T12:00:00.000Z'},
   {trackId:recentTrackA,playedAt:'2026-11-06T13:00:00Z'},
   {trackId:recentTrackB,playedAt:'2026-11-06T12:00:00Z'},
  ]);
  expect(assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:context})
   .map(candidate=>candidate.features.values.recent_play_count)).toEqual([2,1]);
 });
 test('an empty incomplete sample leaves all tracks missing',()=>{
  const result=assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:recentContext([])});
  expect(result.map(candidate=>candidate.features.values.recent_play_count)).toEqual([undefined,undefined]);
 });
 test('only events inside the trailing 30-day window contribute and the boundary is inclusive',()=>{
  const context=recentContext([
   {trackId:recentTrackA,playedAt:'2026-10-08T12:00:00.000Z'},
   {trackId:recentTrackA,playedAt:'2026-10-08T11:59:59.999Z'},
   {trackId:recentTrackB,playedAt:'2026-09-01T12:00:00.000Z'},
  ]);
  expect(assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:context})
   .map(candidate=>candidate.features.values.recent_play_count)).toEqual([1,undefined]);
 });
 test('a cache exactly 24 hours old is usable but one millisecond older is missing',()=>{
  const context=recentContext([{trackId:recentTrackA,playedAt:'2026-11-06T11:00:00Z'}]);
  context.fetchedAt='2026-11-06T12:00:00.000Z';
  expect(assembleLibraryCandidates([spotifyRow()],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBe(1);
  context.fetchedAt='2026-11-06T11:59:59.999Z';
  expect(assembleLibraryCandidates([spotifyRow()],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBeUndefined();
 });
 test('a play exactly at the fetch and as-of instant is usable',()=>{
  expect(assembleLibraryCandidates([spotifyRow()],{...options,tasteContext:recentContext([{trackId:recentTrackA,playedAt:now}])})[0]!
   .features.values.recent_play_count).toBe(1);
 });
 test.each([
  {name:'after as-of',fetchedAt:now,playedAt:'2026-11-07T12:00:00.001Z'},
  {name:'after fetch but before as-of',fetchedAt:'2026-11-07T10:00:00Z',playedAt:'2026-11-07T11:00:00Z'},
 ])('a future event $name invalidates the whole sample',({fetchedAt,playedAt})=>{
  const context={...recentContext([
   {trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'},
   {trackId:recentTrackB,playedAt},
  ]),fetchedAt};
  const result=assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:context});
  expect(result.map(candidate=>candidate.features.values.recent_play_count)).toEqual([undefined,undefined]);
 });
 test.each([
  {name:'null event',event:null},
  {name:'string event',event:'not an event'},
  {name:'missing track',event:{playedAt:'2026-11-06T12:00:00Z'}},
  {name:'non-Spotify track ID',event:{trackId:'demo:track',playedAt:'2026-11-06T12:00:00Z'}},
  {name:'short Spotify track ID',event:{trackId:recentTrackB.slice(1),playedAt:'2026-11-06T12:00:00Z'}},
  {name:'invalid Spotify track characters',event:{trackId:'000000000000000000000_',playedAt:'2026-11-06T12:00:00Z'}},
  {name:'missing timestamp',event:{trackId:recentTrackB}},
  {name:'unparseable timestamp',event:{trackId:recentTrackB,playedAt:'bad'}},
  {name:'date-only timestamp',event:{trackId:recentTrackB,playedAt:'2026-11-06'}},
  {name:'non-ISO timestamp',event:{trackId:recentTrackB,playedAt:'November 6, 2026 12:00:00 GMT'}},
  {name:'timestamp without timezone',event:{trackId:recentTrackB,playedAt:'2026-11-06T12:00:00'}},
  {name:'numeric timestamp',event:{trackId:recentTrackB,playedAt:0}},
  {name:'impossible calendar date',event:{trackId:recentTrackB,playedAt:'2026-02-30T12:00:00Z'}},
 ])('a malformed cached $name invalidates the whole sample without throwing',({event})=>{
  const context={...recentContext([]),events:[{trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'},event]} as unknown as TasteContext;
  const result=assembleLibraryCandidates([spotifyRow(recentTrackA),spotifyRow(recentTrackB)],{...options,tasteContext:context});
  expect(result.map(candidate=>candidate.features.values.recent_play_count)).toEqual([undefined,undefined]);
 });
 test.each([
  {name:'future fetch',patch:{fetchedAt:'2026-11-07T12:00:00.001Z'}},
  {name:'invalid fetch time',patch:{fetchedAt:'bad'}},
  {name:'date-only fetch time',patch:{fetchedAt:'2026-11-07'}},
  {name:'timezone-free fetch time',patch:{fetchedAt:'2026-11-07T12:00:00'}},
  {name:'wrong source',patch:{source:'other-provider'}},
  {name:'claims complete history',patch:{completeHistory:true}},
  {name:'provider error',patch:{error:{code:'PROVIDER_FAILED',message:'Unavailable',retryable:true}}},
  {name:'missing events',patch:{events:undefined}},
  {name:'null events',patch:{events:null}},
  {name:'non-array events',patch:{events:{}}},
 ])('malformed or unavailable context ($name) leaves listening observations missing',({patch})=>{
  const context={...recentContext([{trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'}]),...patch} as unknown as TasteContext;
  expect(assembleLibraryCandidates([spotifyRow()],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBeUndefined();
 });
 test('reading the cached sample never mutates rows, event order, timestamps, or context',()=>{
  const rows=[spotifyRow(recentTrackB),spotifyRow(recentTrackA)];
  const context=recentContext([
   {trackId:recentTrackA,playedAt:'2026-11-06T13:00:00Z'},
   {trackId:recentTrackB,playedAt:'2026-11-06T07:00:00-05:00'},
   {trackId:recentTrackA,playedAt:'2026-11-06T12:00:00Z'},
   {trackId:recentTrackB,playedAt:'2026-11-06T12:00:00.000Z'},
  ]);
  const beforeRows=structuredClone(rows),beforeContext=structuredClone(context);
  const candidates=assembleLibraryCandidates(rows,{...options,tasteContext:context});
  expect(candidates.map(candidate=>candidate.features.values.recent_play_count)).toEqual([1,2]);
  expect(rows).toEqual(beforeRows);expect(context).toEqual(beforeContext);
 });
});
