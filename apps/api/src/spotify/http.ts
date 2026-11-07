import {SpotifyError} from './errors';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type HttpOptions = {fetch?: Fetch; now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number; timeoutMs?: number};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Only reads and OAuth exchanges use retries; never use this for Spotify mutations. */
export class SpotifyHttp {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  private readonly fetcher: Fetch;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private blockedUntil = 0;
  constructor(options: HttpOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.fetcher = options.fetch ?? fetch;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }
  private rateError() {return new SpotifyError('SPOTIFY_RATE_LIMITED', 'Spotify is rate limiting requests. Retry after the indicated delay.', 429, true, this.blockedUntil);}
  async json(url: string, init: RequestInit = {}, options: {token?: boolean; attempts?: number} = {}): Promise<unknown> {
    const attempts = options.attempts ?? 4;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const remaining = this.blockedUntil - this.now();
      if (remaining > 30_000) throw this.rateError();
      if (remaining > 0) await this.sleep(remaining);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response | undefined;
      let body: unknown;
      try {
        const result = await Promise.race([
          (async () => {
            const res = await this.fetcher(url, {...init, signal:controller.signal, redirect:'error'});
            response = res;
            // Consume the body under the same timeout as the headers.
            const text = await res.text();
            let parsed: unknown = null;
            if (text) {try {parsed = JSON.parse(text);} catch {if (res.ok) throw new SpotifyError('SPOTIFY_INVALID_RESPONSE', 'Spotify returned an invalid response.', 502, true);}}
            return {res, parsed};
          })(),
          new Promise<never>((_resolve, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Error('timeout'));}, this.timeoutMs);}),
        ]);
        response = result.res; body = result.parsed;
      } catch (error) {
        controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        if (error instanceof SpotifyError) throw error;
        if (attempt + 1 === attempts) throw new SpotifyError('SPOTIFY_UNAVAILABLE', 'Spotify could not be reached. Retry later.', 503, true);
        await this.sleep(this.backoff(attempt));
        continue;
      } finally {if (timer) clearTimeout(timer);}
      if (response.ok) return body;
      const status = response.status;
      if (options.token && status === 400 && body && typeof body === 'object' && 'error' in body && body.error === 'invalid_grant') throw new SpotifyError('SPOTIFY_REAUTH_REQUIRED', 'Spotify authorization expired or was revoked. Reconnect your account.', 401);
      if (status === 429) {
        const raw = response.headers.get('retry-after');
        const seconds = raw !== null && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : NaN;
        const date = raw ? Date.parse(raw) - this.now() : NaN;
        const delay = Math.max(1000, Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? date : this.backoff(attempt));
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
        if (delay > 30_000 || attempt + 1 === attempts) throw this.rateError();
        continue;
      }
      if (status >= 500) {
        if (attempt + 1 < attempts) {await this.sleep(this.backoff(attempt)); continue;}
        throw new SpotifyError('SPOTIFY_UNAVAILABLE', 'Spotify is temporarily unavailable.', 503, true);
      }
      if (status === 401) throw new SpotifyError(options.token ? 'SPOTIFY_CLIENT_REJECTED' : 'SPOTIFY_UNAUTHORIZED', 'Spotify authorization was rejected.', options.token ? 503 : 401);
      if (status === 403) throw new SpotifyError('SPOTIFY_FORBIDDEN', 'Spotify denied access. Check application access and granted scopes.', 403);
      throw new SpotifyError('SPOTIFY_REQUEST_REJECTED', 'Spotify rejected the request.', 502);
    }
    throw new SpotifyError('SPOTIFY_UNAVAILABLE', 'Spotify is temporarily unavailable.', 503, true);
  }
  private backoff(attempt: number) {return Math.min(8000, 500 * 2 ** attempt) + Math.floor(this.random() * 250);}
}
