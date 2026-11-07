import {z} from 'zod';
import {IdSchema, PUBLIC_ROUTES} from '@sortfm/contracts';
import {loadConfig} from '../config';
import {TokenCipher} from './crypto';

export function loadSpotifyConfig(env: Record<string, string | undefined> = process.env) {
  const api = loadConfig(env);
  const clientId = z.string().trim().min(1).parse(env.SPOTIFY_CLIENT_ID);
  const allowedUserIds = new Set(z.array(IdSchema).min(1).parse((env.SPOTIFY_ALLOWED_USER_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean)));
  const encryptionKey = z.string().parse(env.TOKEN_ENCRYPTION_KEY);
  new TokenCipher(encryptionKey);
  const sessionSecret = z.string().min(32).parse(env.SESSION_SECRET);
  const redirectUri = env.SPOTIFY_REDIRECT_URI ?? `${api.apiOrigin}${PUBLIC_ROUTES.authCallback.path}`;
  const redirect = new URL(redirectUri);
  if (redirect.origin !== api.apiOrigin || redirect.pathname !== PUBLIC_ROUTES.authCallback.path || redirect.search || redirect.hash || redirect.username || redirect.password) throw new Error('Spotify redirect must exactly match the configured API callback');
  for (const origin of [api.apiOrigin, api.webOrigin]) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !(api.mode !== 'production' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Spotify requires HTTPS or a development loopback IP');
  }
  // Read-only A1 consent. A2 must explicitly request write scopes before offering mutations.
  return {...api, clientId, allowedUserIds, encryptionKey, sessionSecret, redirectUri,
    scopes: ['user-library-read', 'user-read-private', 'user-read-recently-played'],
    secureCookies: api.apiOrigin.startsWith('https:'), sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    oauthTtlMs: 10 * 60 * 1000, requestTimeoutMs: 15_000,
  };
}
export type SpotifyConfig = ReturnType<typeof loadSpotifyConfig>;
