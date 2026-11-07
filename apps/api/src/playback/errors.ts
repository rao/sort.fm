import type {PlaybackErrorCode} from '@sortfm/contracts';
import {SpotifyError} from '../spotify/errors';
const errors:Record<PlaybackErrorCode,[number,string]>={
 PLAYBACK_PREMIUM_REQUIRED:[403,'Spotify Premium is required for browser playback.'],
 PLAYBACK_RECONNECT_REQUIRED:[401,'Connect playback permissions again. Your library connection is unchanged.'],
 PLAYBACK_UNAVAILABLE:[503,'Playback is temporarily unavailable.'],
 PLAYBACK_SCOPE_REJECTED:[403,'Spotify did not grant the exact permissions required for isolated playback.'],
 PLAYBACK_DEVICE_UNAVAILABLE:[409,'The selected playback device is unavailable.'],
 PLAYBACK_DEVICE_RESTRICTED:[403,'Spotify does not allow control of the selected device.'],
 PLAYBACK_TRACK_UNAVAILABLE:[422,'This track is unavailable for playback.'],
 PLAYBACK_RATE_LIMITED:[429,'Spotify is rate limiting playback. Try again after the indicated delay.'],
 PLAYBACK_OUTCOME_UNKNOWN:[503,'The playback request could not be confirmed. Check player state before trying again.'],
};
export class PlaybackError extends SpotifyError {
 constructor(code:PlaybackErrorCode,retryAt:number|null=null){const [status,message]=errors[code];super(code,message,status,false,retryAt);}
}
