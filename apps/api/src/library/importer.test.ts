import {expect, test} from 'bun:test';
import {LibraryImporter} from './importer';
import {normalizeSavedTrack} from './normalize';
import {TestStore} from '../auth/test-support/store';
import {SpotifyError} from '../spotify/errors';
import {LibraryImportStatusSchema} from '@sortfm/contracts';

const userId = 'spotify:owner';
const id = (n: number) => n.toString().padStart(22, '0');
const item = (n: number, addedAt = '2020-01-02T03:04:05Z') => ({added_at:addedAt, track:{id:id(n), uri:`spotify:track:${id(n)}`, name:`Song ${n}`, artists:[{id:'artist', name:'Artist'}], album:{name:'Album', images:[], release_date:'2019'}, duration_ms:180000, explicit:false}});
function source(total: number, overrides: {page?:(offset:number, call:number) => unknown; recent?:unknown} = {}) {
  const offsets: number[] = [];
  return {offsets, get:async (_user: string, path: string) => {
    expect(_user).toBe(userId);
    if (path.startsWith('/me/player/recently-played')) return overrides.recent ?? {items:[]};
    expect(path).toMatch(/^\/me\/tracks\?limit=50&offset=\d+$/);
    const offset = Number(new URL(path, 'https://api.spotify.com').searchParams.get('offset')); offsets.push(offset);
    if (overrides.page) return overrides.page(offset, offsets.length);
    return {offset, limit:50, total, items:Array.from({length:Math.min(50, total - offset)}, (_, i) => item(offset+i)), next:offset + 50 < total ? `https://api.spotify.com/v1/me/tracks?offset=${offset+50}&limit=50` : null};
  }};
}
function worker(store: TestStore, api: ReturnType<typeof source>, clock?: {now:() => number}) {return new LibraryImporter(store, api, {now:clock?.now});}

test('imports 2,700 unique tracks in 54 data pages, retains timestamps, verifies boundary, and persists weak recent context', async () => {
  const store = new TestStore(), api = source(2700, {recent:{items:[{track:{id:id(3)}, played_at:'2026-11-07T12:00:00Z'}]}}), importer = worker(store, api);
  const requested = await importer.requestSync(userId);
  expect(requested.status).toBe('pending');
  await importer.run(userId);
  const progress = await importer.status(userId);
  expect(LibraryImportStatusSchema.parse(progress)).toMatchObject({status:'complete', processed:2700, total:2700, failed:0, nextOffset:2700});
  expect(api.offsets).toEqual([...Array.from({length:54}, (_, i) => i * 50), 0]);
  expect(store.data.saved.size).toBe(2700); expect(store.data.observations.size).toBe(2700);
  expect(store.data.saved.get(`${userId}/${id(2)}`)?.originalAddedAt).toBe('2020-01-02T03:04:05Z');
  expect(store.data.taste.get(userId)).toMatchObject({completeHistory:false, events:[{trackId:id(3), playedAt:'2026-11-07T12:00:00Z'}], error:null});
});

test('normalization retains unavailable IDs, missing art and partial metadata; invalid/local/null observations are counted', () => {
  expect(normalizeSavedTrack(item(1)).track).toMatchObject({trackId:id(1), imageUrl:null, releaseDate:'2019'});
  expect(normalizeSavedTrack({...item(2), track:{...item(2).track, is_playable:false, restrictions:{reason:'market'}}}).track?.isPlayable).toBe(false);
  expect(normalizeSavedTrack({added_at:'2020-01-02T03:04:05Z', track:{id:id(4)}}).track).toMatchObject({title:'Unavailable track', artists:[{id:null, name:'Unknown artist'}], isPlayable:false});
  expect(normalizeSavedTrack({added_at:'invalid', track:item(1).track}).reason).toBe('invalid_timestamp');
  expect(normalizeSavedTrack({added_at:item(1).added_at, track:null}).reason).toBe('null_track');
  expect(normalizeSavedTrack({...item(1), track:{...item(1).track, is_local:true}}).reason).toBe('local_track');
  const relinked = normalizeSavedTrack({...item(1), track:{...item(1).track, id:id(8), uri:`spotify:track:${id(8)}`, linked_from:{id:id(1)}}});
  expect(relinked.track?.trackId).toBe(id(1));
  expect(relinked.track?.spotifyUri).toBe(`spotify:track:${id(1)}`);
});

test('null/local tracks are retained as raw observations and do not prevent a truthful complete import', async () => {
  const rows = [item(1), {added_at:item(1).added_at, track:null}, {...item(2), track:{...item(2).track, is_local:true}}, {...item(3), track:{...item(3).track, is_playable:false}}];
  const store = new TestStore(), importer = worker(store, source(4, {page:() => ({offset:0, limit:50, total:4, items:rows, next:null})}));
  await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'complete', processed:2, total:4, failed:2, nextOffset:4});
  expect(store.data.observations.size).toBe(4); expect(store.data.saved.size).toBe(2);
});

test('page commit failure rolls back rows and cursor, and a fresh worker resumes safely', async () => {
  let now = 0; const clock = {now:() => now};
  const store = new TestStore(), api = source(120), importer = worker(store, api, clock);
  await importer.requestSync(userId); store.failNextPage = true; await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'failed', nextOffset:0, processed:0});
  expect(store.data.saved.size).toBe(0);
  now = 30_001; const restarted = worker(store, api, clock); await restarted.requestSync(userId); await restarted.run(userId);
  expect(await restarted.status(userId)).toMatchObject({status:'complete', processed:120}); expect(store.data.saved.size).toBe(120);
});

test('network failure resumes at the last committed offset and rechecks first page', async () => {
  let now = 0; const clock = {now:() => now};
  const store = new TestStore(); let fail = true;
  const api = source(120, {page:offset => {
    if (offset === 50 && fail) {fail = false; throw new SpotifyError('SPOTIFY_UNAVAILABLE', 'Unavailable', 503, true);}
    return {offset, limit:50, total:120, items:Array.from({length:Math.min(50, 120-offset)}, (_, i) => item(offset+i)), next:offset+50<120 ? 'https://api.spotify.com/v1/me/tracks' : null};
  }});
  const importer = worker(store, api, clock); await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'failed', processed:50, nextOffset:50});
  now = 30_001; const restarted = worker(store, api, clock); await restarted.requestSync(userId); await restarted.run(userId);
  expect(await restarted.status(userId)).toMatchObject({status:'complete', processed:120});
  expect(api.offsets).toEqual([0, 50, 0, 50, 100, 0]);
});

test('duplicates cannot silently pass reconciliation or create duplicate rows', async () => {
  const store = new TestStore(), api = source(100, {page:offset => ({offset, limit:50, total:100, items:Array.from({length:50}, (_, i) => item(i)), next:offset === 0 ? 'https://attacker.test/do-not-follow' : null})});
  const importer = worker(store, api); await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'failed', processed:50, error:{code:'LIBRARY_CHANGED', retryable:true}});
  expect(store.data.saved.size).toBe(50); expect(api.offsets.length).toBeLessThan(12);
});

test('empty library completes and resync preserves original save timestamps and reviewed state', async () => {
  const empty = new TestStore(), emptyImporter = worker(empty, source(0));
  await emptyImporter.requestSync(userId); await emptyImporter.run(userId);
  expect(await emptyImporter.status(userId)).toMatchObject({status:'complete', processed:0, total:0});
  const store = new TestStore(), importer = worker(store, source(1)); await importer.requestSync(userId); await importer.run(userId);
  store.data.saved.get(`${userId}/${id(0)}`)!.currentStatus = 'kept';
  const next = worker(store, source(1, {page:() => ({offset:0, limit:50, total:1, items:[item(0, '2026-11-07T12:00:00Z')], next:null})}));
  await next.requestSync(userId); await next.run(userId);
  expect(store.data.saved.size).toBe(1);
  expect(store.data.saved.get(`${userId}/${id(0)}`)).toMatchObject({originalAddedAt:'2020-01-02T03:04:05Z', currentStatus:'kept'});
});

test('running jobs coalesce across workers and expired leases recover after process death', async () => {
  let now = 0; const store = new TestStore(), api = source(10), importer = worker(store, api, {now:() => now});
  const first = await importer.requestSync(userId), second = await importer.requestSync(userId);
  expect(first.jobId).toBe(second.jobId);
  const job = store.data.jobs.get(userId)!; job.progress.status = 'running'; job.lease = {id:'dead-process', until:100};
  await importer.run(userId); expect(api.offsets.length).toBe(0);
  now = 101; await Promise.all([importer.run(userId), worker(store, api, {now:() => now}).run(userId)]);
  expect(await importer.status(userId)).toMatchObject({status:'complete', processed:10}); expect(api.offsets).toEqual([0, 0]);
});

test('rate-limit deadlines survive worker restart and manual sync cannot bypass them', async () => {
  let now = 0, limited = true; const store = new TestStore();
  const api = source(1, {page:() => {
    if (limited) throw new SpotifyError('SPOTIFY_RATE_LIMITED', 'Rate limited', 429, true, 3600_000);
    return {offset:0, limit:50, total:1, items:[item(1)], next:null};
  }});
  const importer = worker(store, api, {now:() => now}); await importer.requestSync(userId); await importer.run(userId);
  expect(store.data.jobs.get(userId)?.retryAt).toBe(3600_000);
  const next = worker(store, api, {now:() => now}); await next.requestSync(userId); await next.run(userId); expect(api.offsets.length).toBe(1);
  now = 3600_001; limited = false; await next.run(userId); expect(await next.status(userId)).toMatchObject({status:'complete'});
});

test('optional recently-played failure never fails the core import or invents a complete history', async () => {
  const store = new TestStore(), api = source(1), get = api.get;
  api.get = async (user, path) => {if (path.includes('recently-played')) throw new SpotifyError('SPOTIFY_FORBIDDEN', 'No scope', 403); return get(user, path);};
  const importer = worker(store, api); await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'complete'});
  expect(store.data.taste.get(userId)).toMatchObject({completeHistory:false, events:[], error:{code:'SPOTIFY_FORBIDDEN'}});
});

test('a changed library restarts from zero, preserves earlier snapshot rows, and eventually reconciles', async () => {
  const store = new TestStore(); let shifted = false;
  const api = source(60, {page:offset => {
    if (offset === 50) shifted = true;
    const total = shifted ? 61 : 60;
    return {offset, limit:50, total, items:Array.from({length:Math.min(50, total-offset)}, (_, i) => item(offset+i)), next:offset+50<total ? 'https://api.spotify.com/v1/me/tracks' : null};
  }});
  const importer = worker(store, api); await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'complete', total:61, processed:61});
  expect(api.offsets).toEqual([0, 50, 0, 50, 0]);
  expect(store.data.observations.size).toBe(111);
});

test('malformed and premature empty pages fail without advancing the cursor', async () => {
  for (const page of [{offset:999, limit:50, total:50, items:[item(1)], next:null}, {offset:0, limit:50, total:50, items:[], next:null}]) {
    const store = new TestStore(), importer = worker(store, source(50, {page:() => page}));
    await importer.requestSync(userId); await importer.run(userId);
    expect(await importer.status(userId)).toMatchObject({status:'failed', nextOffset:0, processed:0}); expect(store.data.saved.size).toBe(0);
  }
});

test('a stale worker cannot commit after another process acquires its expired lease', async () => {
  let now = 0, unblock!: () => void, announce!: () => void;
  const blocked = new Promise<void>(resolve => {unblock = resolve;}), began = new Promise<void>(resolve => {announce = resolve;});
  const store = new TestStore(), slowApi = source(1), originalGet = slowApi.get; let block = true;
  slowApi.get = async (user, path) => {if (block) {block = false; announce(); await blocked;} return originalGet(user, path);};
  const slow = worker(store, slowApi, {now:() => now}); await slow.requestSync(userId); const running = slow.run(userId); await began;
  now = 300_001;
  const fast = worker(store, source(2), {now:() => now}); await fast.run(userId); unblock(); await running;
  expect(await fast.status(userId)).toMatchObject({status:'complete', processed:2, total:2}); expect(store.data.saved.size).toBe(2);
});

test('automatic recovery gets a new bounded reconciliation budget after source stabilizes', async () => {
  let now = 0, stable = false;
  const store = new TestStore(), api = source(100, {page:offset => ({offset, limit:50, total:100, items:Array.from({length:50}, (_, i) => item(stable ? offset+i : i)), next:offset === 0 ? 'https://api.spotify.com/v1/me/tracks' : null})});
  const importer = worker(store, api, {now:() => now}); await importer.requestSync(userId); await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'failed'});
  stable = true; now = 30_001; await importer.run(userId);
  expect(await importer.status(userId)).toMatchObject({status:'complete', processed:100});
});
