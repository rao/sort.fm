import type {AuthService} from '../auth/service';
import {SpotifyHttp} from './http';
import {SpotifyError} from './errors';

/** A read-only adapter: paths are allowlisted and no remote next-page URL is followed. */
export class SpotifyClient {
  constructor(private readonly auth: AuthService, private readonly http: SpotifyHttp) {}
  async get(userId: string, path: string): Promise<unknown> {
    const url = new URL(path, 'https://api.spotify.com/v1/');
    // Leading /me is intentionally relative to /v1, never to an arbitrary origin.
    if (!/^\/me(?:\/tracks|\/player\/recently-played)?(?:\?|$)/.test(path) || path.includes('#') || path.includes('\\')) throw new SpotifyError('INVALID_SPOTIFY_PATH', 'Unsupported Spotify read path.', 400);
    url.pathname = `/v1${url.pathname}`;
    let credential = await this.auth.accessToken(userId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {return await this.http.json(url.toString(), {headers:{Authorization:`Bearer ${credential.token}`}});}
      catch (error) {
        if (!(error instanceof SpotifyError) || error.code !== 'SPOTIFY_UNAUTHORIZED') throw error;
        if (attempt === 1) {
          await this.auth.revoke(userId, credential.version);
          throw new SpotifyError('SPOTIFY_REAUTH_REQUIRED', 'Spotify authorization was rejected. Reconnect your account.', 401);
        }
        credential = await this.auth.accessToken(userId, credential.version);
      }
    }
    throw new Error('Unreachable');
  }
}
