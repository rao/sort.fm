import {expect,test} from 'bun:test';
import {AudioFeaturesInputSchema,AudioFeatureStatusSchema,FeatureVectorSchema} from '../src/index';

const values={energy:0,tempo_bpm:123,loudness_db:-8,key_sin:0,key_cos:1,mode_major:0} as const;
const features={featureVersion:'sortfm.features.v1',values,provenance:'musicae',permittedForTraining:true,rightsBasis:'Authored compatibility fixture'};

test('Musicae normalized input preserves partial observations without inventing unavailable features',()=>{
 const parsed=AudioFeaturesInputSchema.parse({trackId:'0000000000000000000001',provider:'musicae',raw:{valence:0.8},normalized:features,
  fetchedAt:'2026-11-07T16:00:00.000Z',status:'success',dataQuality:{happiness:'not_provided',soundnet_popularity:'not_provided'}});
 expect(parsed.provider).toBe('musicae');expect(parsed.normalized.provenance).toBe('musicae');
 expect(parsed.normalized.values).toEqual(values);
 expect(parsed.normalized.values.happiness).toBeUndefined();expect(parsed.normalized.values.soundnet_popularity).toBeUndefined();
 expect(FeatureVectorSchema.parse({...features,values:{...values,happiness:null,soundnet_popularity:null}}).values.happiness).toBeNull();
});

test('audio status can identify either supported provider without changing availability counts',()=>{
 const status={status:'running',featuresReady:1,featuresTotal:3,failed:0,missingness:{happiness:1,soundnet_popularity:1},reason:null} as const;
 for(const provider of ['soundnet','musicae'] as const)expect(AudioFeatureStatusSchema.parse({...status,provider})).toEqual({...status,provider});
 expect(AudioFeatureStatusSchema.safeParse({...status,provider:'unknown'}).success).toBe(false);
});

test('additive provenance retains existing providers and strict normalized units and names',()=>{
 for(const provenance of ['synthetic','licensed','spotify','soundnet','musicae'] as const)expect(FeatureVectorSchema.parse({...features,provenance}).provenance).toBe(provenance);
 for(const invalid of [{valence:0.8},{popularity:0.8},{energy:80},{tempo_bpm:0},{energy:Infinity}])
  expect(FeatureVectorSchema.safeParse({...features,values:invalid}).success).toBe(false);
 expect(FeatureVectorSchema.safeParse({...features,provenance:'unknown'}).success).toBe(false);
});
