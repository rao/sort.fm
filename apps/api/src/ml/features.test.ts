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
 test('recent count reflects only fresh limited observations, wrong users rejected',()=>{
  const one=row();
  const context:TasteContext={userId:'user:1',fetchedAt:now,source:'spotify-recently-played',completeHistory:false,error:null,
    events:[{trackId:one.track.trackId,playedAt:'2026-11-06T12:00:00Z'},
      {trackId:one.track.trackId,playedAt:'2026-11-08T12:00:00Z'},
      {trackId:one.track.trackId,playedAt:'2026-08-01T12:00:00Z'}]};
  expect(assembleLibraryCandidates([one],{...options,tasteContext:context})[0]!.features.values.recent_play_count).toBe(1);
  expect(assembleLibraryCandidates([one],{...options,tasteContext:{...context,fetchedAt:'2026-11-01T12:00:00Z'}})[0]!.features.values.recent_play_count).toBeUndefined();
  expect(()=>assembleLibraryCandidates([one],{...options,tasteContext:{...context,userId:'other'}})).toThrow('CONTEXT_USER_MISMATCH');
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
