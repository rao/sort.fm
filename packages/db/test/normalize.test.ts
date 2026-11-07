import {test, expect} from 'bun:test';
import {normalizeSoundNet} from '../../../apps/api/src/jobs/soundnet/normalize';
test('normalizes percentages, duration, dB and harmonic encoding without inventing zeros', () => {
 const result = normalizeSoundNet({energy:80, instrumentalness:0, loudness:'-5 dB', duration:'3:09', key:'C#', mode:'minor', tempo:'122', happiness:'60'}, 'a'.repeat(22), {permittedForTraining:true, rightsBasis:'owner reviewed'});
 expect(result.normalized.values).toMatchObject({energy:0.8,instrumentalness:0,loudness_db:-5,duration_ms:189000,mode_major:0,tempo_bpm:122,happiness:0.6,danceability:null});
 expect(result.normalized.values.key_sin).toBeCloseTo(0.5);
 expect(result.dataQuality['danceability_missing']).toBe(true);
 expect(result.raw).toEqual({energy:80, instrumentalness:0, loudness:'-5 dB', duration:'3:09', key:'C#', mode:'minor', tempo:'122', happiness:'60'});
});
test('invalid fields stay null, error/empty bodies and identity mismatches fail', () => {
 const result=normalizeSoundNet({energy:999,tempo:'oops',speechiness:10,loudness:'LOUD'}, 'a'.repeat(22));
 expect(result.normalized.values.energy).toBeNull(); expect(result.normalized.values.tempo_bpm).toBeNull();
 for (const raw of [null,[],{error:'no track'}, {}, {energy:50,spotify_id:'b'.repeat(22)}]) expect(()=>normalizeSoundNet(raw,'a'.repeat(22))).toThrow();
 expect(result.normalized.permittedForTraining).toBe(false);
});
