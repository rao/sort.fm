import {PlaybackTransport} from '../playback/transport';
import {SpotifyError} from './errors';
import type {Fetch} from './http';

/** Supply only to primary OAuth's SpotifyHttp, never to playback or mutation clients.
 * The explicit delegate permits an audited/test transport; there is no global fallback.
 */
export function createPilotOAuthFetch(delegate:Fetch):Fetch {
 return async(url,init={})=>{
  const method=init.method??'GET';
  const grants=init.body instanceof URLSearchParams?init.body.getAll('grant_type'):[];
  const token=url==='https://accounts.spotify.com/api/token' && method==='POST' && grants.length===1 && ['authorization_code','refresh_token'].includes(grants[0]!);
  const profile=url==='https://api.spotify.com/v1/me' && method==='GET' && init.body==null;
  if(!token && !profile)throw new SpotifyError('PILOT_ACTION_NOT_ALLOWED','This provider request is not enabled for this pilot.',403,false);
  return delegate(url,{...init,redirect:'error'});
 };
}
/** Local refusal, not a provider response. A 403 lets existing transports retain
 * terminal/rejected semantics instead of treating a thrown fetch error as an
 * ambiguous network write. No delegate exists, including for reconciliation reads. */
export const denyPilotProviderFetch:Fetch=async()=>Response.json({code:'PILOT_ACTION_NOT_ALLOWED'},{status:403});

/** PlaybackTransport retains its existing safe error mapping, but has no network delegate. */
export function createPilotPlaybackTransport():PlaybackTransport {
 return new PlaybackTransport({fetch:denyPilotProviderFetch});
}
