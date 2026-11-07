import {HttpUrlSchema, IdSchema, SpotifyTrackIdSchema, TimestampSchema, TrackCardSchema, type TrackCard} from '@sortfm/contracts';
import type {ImportObservation} from '../auth/store';
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback;

/** Null/local tracks cannot be represented by the frozen Spotify TrackCard contract. */
export function normalizeSavedTrack(raw: unknown): {track: TrackCard | null; reason: ImportObservation['reason']} {
  const item = object(raw), track = object(item.track);
  if (item.track == null) return {track:null, reason:'null_track'};
  if (track.is_local === true || (typeof track.uri === 'string' && track.uri.startsWith('spotify:local:'))) return {track:null, reason:'local_track'};
  if (!TimestampSchema.safeParse(item.added_at).success) return {track:null, reason:'invalid_timestamp'};
  // Legacy/extended responses may still relink tracks. The original saved ID is the library identity.
  const originalId = object(track.linked_from).id;
  const trackId = SpotifyTrackIdSchema.safeParse(originalId).success ? originalId : track.id;
  if (!SpotifyTrackIdSchema.safeParse(trackId).success) return {track:null, reason:'invalid_track'};
  const album = object(track.album);
  const image = Array.isArray(album.images) ? album.images.map(object).find(x => HttpUrlSchema.safeParse(x.url).success)?.url : null;
  const artists = Array.isArray(track.artists) ? track.artists.map(object).map(artist => ({id:IdSchema.safeParse(artist.id).success ? artist.id as string : null, name:text(artist.name, 'Unknown artist')})) : [];
  const duration = typeof track.duration_ms === 'number' && Number.isSafeInteger(track.duration_ms) && track.duration_ms >= 0 ? track.duration_ms : 0;
  const parsed = TrackCardSchema.safeParse({trackId, source:'spotify', spotifyUri:`spotify:track:${trackId}`, title:text(track.name, 'Unavailable track'), artists:artists.length ? artists : [{id:null, name:'Unknown artist'}], album:text(album.name, ''), imageUrl:image ?? null, durationMs:duration, explicit:track.explicit === true, originalAddedAt:item.added_at, releaseDate:typeof album.release_date === 'string' && /^\d{4}(-\d{2})?(-\d{2})?$/.test(album.release_date) ? album.release_date : null, isPlayable:track.is_playable !== false && !object(track.restrictions).reason && typeof track.name === 'string' && duration > 0});
  return parsed.success ? {track:parsed.data, reason:null} : {track:null, reason:'invalid_track'};
}
