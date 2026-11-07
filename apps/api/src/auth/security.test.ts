import {describe, expect, test} from 'bun:test';
import {TokenCipher, digest, newSecret, pkceChallenge} from './crypto';
import {loadSpotifyConfig} from './config';

describe('credential security', () => {
  test('PKCE uses RFC7636 S256 and opaque secrets are unpredictable', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(newSecret()).not.toBe(newSecret());
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digest('session')).not.toContain('session');
  });
  test('encryption authenticates the owner/purpose and detects tampering', () => {
    const cipher = new TokenCipher(Buffer.alloc(32, 7).toString('base64'));
    const sealed = cipher.seal('refresh-token', 'owner:refresh');
    expect(sealed).not.toContain('refresh-token');
    expect(cipher.open(sealed, 'owner:refresh')).toBe('refresh-token');
    expect(cipher.seal('refresh-token', 'owner:refresh')).not.toBe(sealed);
    expect(() => cipher.open(sealed, 'attacker:refresh')).toThrow();
    expect(() => cipher.open(sealed.slice(0, -4) + 'AAAA', 'owner:refresh')).toThrow();
    expect(() => new TokenCipher('not-a-key')).toThrow();
  });
  test('configuration rejects empty allowlist, weak keys and insecure callbacks', () => {
    const env = {SPOTIFY_CLIENT_ID:'client', SPOTIFY_ALLOWED_USER_IDS:'owner', TOKEN_ENCRYPTION_KEY:Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET:'s'.repeat(40)};
    const config = loadSpotifyConfig(env);
    expect(config.redirectUri).toBe('http://127.0.0.1:3001/api/auth/spotify/callback');
    expect(config.scopes).toContain('user-library-read');
    expect(config.scopes).not.toContain('user-library-modify');
    expect(() => loadSpotifyConfig({...env, SPOTIFY_ALLOWED_USER_IDS:''})).toThrow();
    expect(() => loadSpotifyConfig({...env, SESSION_SECRET:'short'})).toThrow();
    expect(() => loadSpotifyConfig({...env, SPOTIFY_REDIRECT_URI:'http://localhost:3001/api/auth/spotify/callback'})).toThrow();
    expect(() => loadSpotifyConfig({...env, NODE_ENV:'production', SPOTIFY_REDIRECT_URI:'http://127.0.0.1:3001/api/auth/spotify/callback'})).toThrow();
    expect(() => loadSpotifyConfig({...env, SPOTIFY_REDIRECT_URI:'https://evil.test/callback'})).toThrow();
  });
});
