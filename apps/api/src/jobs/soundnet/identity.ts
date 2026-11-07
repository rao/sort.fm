import {TrackCardSchema,type TrackCard,type AudioFeaturesInput} from '@sortfm/contracts';
import {normalizeSoundNet} from './normalize';
export const TITLE_VERIFIER='soundnet.title-fingerprint.v1';
export const VERIFICATION_METHOD='canonical_title_artist_fingerprint_and_duration';
/** Conservative ASCII slug comparison. Keep every title/version/featured-artist word;
 * unsupported scripts and opaque provider IDs remain missing, never fuzzy-match. */
function slug(value:unknown):string {
 if(typeof value!=='string'||!value.trim()||/[^\x20-\x7e]/.test(value))throw new Error('UNSUPPORTED_IDENTITY');
 const result=value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
 if(!result)throw new Error('UNSUPPORTED_IDENTITY');return result;
}
export function titleLookup(track:TrackCard){
 TrackCardSchema.parse(track);
 if(track.source!=='spotify'||track.durationMs<=0||track.title.length>500||track.artists.some(a=>a.name.length>250))throw new Error('UNSUPPORTED_IDENTITY');
 slug(track.title);for(const artist of track.artists)slug(artist.name);
 return {title:track.title,artists:track.artists.map(a=>a.name)};
}
/** Concatenation loses field boundaries; callers with a known candidate set must
 * reject duplicate fingerprints, and operator review is required for acceptance. */
export function titleFingerprint(track:TrackCard){titleLookup(track);return [slug(track.title),...track.artists.map(a=>slug(a.name))].join('-');}
export function normalizeVerifiedTitle(raw:unknown,track:TrackCard,rights:{permittedForTraining:boolean;rightsBasis?:string}={permittedForTraining:false},fetchedAt?:string):AudioFeaturesInput {
 titleLookup(track);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('MISSING_IDENTITY');
 const body=raw as Record<string,unknown>;
 // This is a provider fingerprint, not unique recording proof. Structured identity
 // is optional in observed responses, but any conflicting supplied field rejects.
 if(body.type!==undefined&&body.type!=='track'&&body.type!=='song')throw new Error('IDENTITY_TYPE_MISMATCH');
 if(typeof body.id!=='string'||body.id.length>4096||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.id))throw new Error('MALFORMED_IDENTITY');
 const bytes=Buffer.from(body.id,'base64');if(bytes.toString('base64')!==body.id)throw new Error('MALFORMED_IDENTITY');
 const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 const expected=titleFingerprint(track);
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(decoded)||decoded!==expected)throw new Error('IDENTITY_MISMATCH');
 for(const key of ['title','name'])if(body[key]!==undefined&&slug(body[key])!==slug(track.title))throw new Error('TITLE_MISMATCH');
 if(body.album!==undefined&&slug(body.album)!==slug(track.album))throw new Error('ALBUM_MISMATCH');
 for(const key of ['artist','artists'])if(body[key]!==undefined){
  const values=Array.isArray(body[key])?body[key] as unknown[]:[body[key]];
  if(values.length!==track.artists.length||values.some((value,i)=>slug(value)!==slug(track.artists[i]!.name)))throw new Error('ARTIST_MISMATCH');
 }
 const result=normalizeSoundNet(raw,track.trackId,rights,fetchedAt);
 const duration=result.normalized.values.duration_ms;
 if(duration==null||Math.abs(duration-track.durationMs)>1000)throw new Error('DURATION_MISMATCH');
 result.dataQuality={...result.dataQuality,requestEndpoint:'title_artist',identityVerified:true,identityVerifier:TITLE_VERIFIER,verificationMethod:VERIFICATION_METHOD,identitySlug:decoded,durationDeltaMs:duration-track.durationMs};
 return result;
}
