import {test,expect} from 'bun:test';
import {demoTracks} from '@sortfm/contracts/fixtures';
import {normalizeVerifiedTitle} from './identity';
const track={...demoTracks[0]!,trackId:'a'.repeat(22),source:'spotify' as const,spotifyUri:`spotify:track:${'a'.repeat(22)}` as const,title:'Sunday (feat. Frank Ocean)',artists:[{id:null,name:'Earl Sweatshirt'},{id:null,name:'Frank Ocean'}],durationMs:205800};
const raw={title:'Sunday (feat. Frank Ocean)',artists:['Earl Sweatshirt','Frank Ocean'],id:'c3VuZGF5LWZlYXQtZnJhbmstb2NlYW4tZWFybC1zd2VhdHNoaXJ0LWZyYW5rLW9jZWFu',duration:'3:26',energy:57};
test('guard accepts complete title and all artists, duration rounding, and retains provenance',()=>{
 const result=normalizeVerifiedTitle(raw,track,{permittedForTraining:true,rightsBasis:'reviewed'});
 expect(result.normalized.values.energy).toBe(.57);expect(result.normalized.permittedForTraining).toBe(true);expect(result.dataQuality.identityVerified).toBe(true);expect(result.dataQuality.requestEndpoint).toBe('title_artist');
});
test.each([
 ['wrong artist',{...raw,id:Buffer.from('sunday-feat-frank-ocean-other-artist-frank-ocean').toString('base64')}],
 ['wrong recording version',{...raw,id:Buffer.from('sunday-feat-frank-ocean-live-earl-sweatshirt-frank-ocean').toString('base64')}],
 ['missing featured artist',{...raw,id:Buffer.from('sunday-feat-frank-ocean-earl-sweatshirt').toString('base64')}],
 ['missing identity',{duration:'3:26',energy:57}],['malformed identity',{...raw,id:'not!base64'}],
 ['duration mismatch',{...raw,duration:'3:28'}],['missing duration',{...raw,duration:null}],
 ['contradicting title',{...raw,title:'Sunday - Live'}],['contradicting artist',{...raw,artist:'Other Artist'}],
 ['wrong Spotify ID',{...raw,spotify_id:'b'.repeat(22)}],['episode response',{...raw,type:'episode'}],
] as const)('guard rejects %s instead of caching a plausible vector',(_name,value)=>{expect(()=>normalizeVerifiedTitle(value,track)).toThrow();});
test('guard rejects version stripping and unsupported expected metadata',()=>{
 expect(()=>normalizeVerifiedTitle(raw,{...track,title:'Sunday (feat. Frank Ocean) - Remastered'})).toThrow();
 expect(()=>normalizeVerifiedTitle(raw,{...track,spotifyUri:'spotify:episode:'+track.trackId} as any)).toThrow();
 expect(()=>normalizeVerifiedTitle(raw,{...track,title:'東京'})).toThrow();
});
test('fingerprint assurance explicitly cannot distinguish unknown title/artist partitions',()=>{
 const ambiguous={id:Buffer.from('song-live-artist').toString('base64'),duration:'3:00',energy:55};
 const expected={...track,title:'Song Live',artists:[{id:null,name:'Artist'}],durationMs:180000};
 const first=normalizeVerifiedTitle(ambiguous,expected);
 const second=normalizeVerifiedTitle(ambiguous,{...expected,title:'Song',artists:[{id:null,name:'Live Artist'}]});
 expect(first.dataQuality.verificationMethod).toBe('canonical_title_artist_fingerprint_and_duration');
 expect(second.dataQuality.identitySlug).toBe(first.dataQuality.identitySlug);
 expect(()=>normalizeVerifiedTitle({...ambiguous,title:'Song',artist:'Live Artist'},expected)).toThrow();
});
