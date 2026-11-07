import {expect, test} from 'bun:test';
import {SpotifyHttp} from './http';
import {SpotifyError} from './errors';

test('retries 429 after Retry-After, transient 5xx and network errors with bounded backoff', async () => {
  let now = 0, calls = 0; const waits: number[] = [];
  const http = new SpotifyHttp({fetch:async () => {
    calls++;
    if (calls === 1) return new Response('', {status:429, headers:{'Retry-After':'2'}});
    if (calls === 2) return new Response('', {status:503});
    if (calls === 3) throw new Error('network token-secret');
    return Response.json({ok:true});
  }, now:() => now, sleep:async ms => {waits.push(ms); now += ms;}, random:() => 0});
  expect(await http.json('https://api.spotify.com/v1/me', {method:'GET'})).toEqual({ok:true});
  expect(calls).toBe(4);
  expect(waits[0]).toBe(2000);
  expect(waits.every(x => x > 0)).toBe(true);
});

test('long rate limits return a retry deadline without sleeping or calling early', async () => {
  let calls = 0;
  const http = new SpotifyHttp({fetch:async () => {calls++; return new Response('', {status:429, headers:{'Retry-After':'3600'}});}, now:() => 0});
  for (let i = 0; i < 2; i++) {
    try {await http.json('https://api.spotify.com/v1/me'); throw new Error('expected failure');}
    catch (error) {expect(error).toBeInstanceOf(SpotifyError); expect((error as SpotifyError).retryAt).toBe(3_600_000);}
  }
  expect(calls).toBe(1);
});

test('HTTP-date retry deadlines are respected', async () => {
  let now = Date.parse('2026-11-07T12:00:00Z'), calls = 0; const waits: number[] = [];
  const http = new SpotifyHttp({fetch:async () => ++calls === 1 ? new Response('', {status:429, headers:{'Retry-After':'Sat, 07 Nov 2026 12:00:03 GMT'}}) : Response.json({ok:true}), now:() => now, sleep:async ms => {waits.push(ms); now += ms;}});
  await http.json('https://api.spotify.com/v1/me'); expect(waits).toEqual([3000]);
});

test('terminal errors and exhausted retries expose no upstream body or credentials', async () => {
  for (const status of [400, 401, 403, 500]) {
    let calls = 0;
    const http = new SpotifyHttp({fetch:async () => {calls++; return Response.json({secret:'bearer-secret'}, {status});}, sleep:async () => {}});
    try {await http.json('https://api.spotify.com/v1/me'); throw new Error('expected failure');}
    catch (error) {expect(error).toBeInstanceOf(SpotifyError); expect(JSON.stringify(error)).not.toContain('bearer-secret');}
    expect(calls).toBe(status === 500 ? 4 : 1);
  }
});

test('token invalid_grant requests reauthorization and is not retried', async () => {
  let calls = 0;
  const http = new SpotifyHttp({fetch:async () => {calls++; return Response.json({error:'invalid_grant'}, {status:400});}});
  await expect(http.json('https://accounts.spotify.com/api/token', {method:'POST'}, {token:true})).rejects.toMatchObject({code:'SPOTIFY_REAUTH_REQUIRED', statusCode:401});
  expect(calls).toBe(1);
});

test('timeouts cover reading the response body and are bounded', async () => {
  let calls = 0;
  const http = new SpotifyHttp({timeoutMs:5, sleep:async () => {}, fetch:async () => {
    calls++;
    return new Response(new ReadableStream({start() {}}));
  }});
  await expect(http.json('https://api.spotify.com/v1/me')).rejects.toMatchObject({code:'SPOTIFY_UNAVAILABLE', retryable:true});
  expect(calls).toBe(4);
});

test('malformed success JSON does not leak response text and redirects are forbidden', async () => {
  const http = new SpotifyHttp({fetch:async (_url, init) => {expect(init?.redirect).toBe('error'); return new Response('secret invalid json');}});
  await expect(http.json('https://api.spotify.com/v1/me')).rejects.toMatchObject({code:'SPOTIFY_INVALID_RESPONSE'});
});
