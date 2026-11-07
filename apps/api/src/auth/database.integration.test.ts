import {expect, test} from 'bun:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {A1Store} from './store';
import {AuthService} from './service';
import {loadSpotifyConfig} from './config';
import {SpotifyHttp} from '../spotify/http';
import {SpotifyClient} from '../spotify/client';
import {LibraryImporter} from '../library/importer';

// Explicit opt-in. A1 never installs migrations or silently targets the real library schema.
const adapterRoot = process.env.A1_DATABASE_ADAPTER_ROOT;
const databaseUrl = process.env.TEST_DATABASE_URL;

test.skipIf(!adapterRoot || !databaseUrl)('A1 workflow persists across service reconstruction using D PostgreSQL adapter', async () => {
  const root = resolve(adapterRoot!);
  const {Database} = await import(pathToFileURL(resolve(root, 'packages/db/src/client.ts')).href);
  const {migrate} = await import(pathToFileURL(resolve(root, 'packages/db/src/migrate.ts')).href);
  const {PostgresA1Store} = await import(pathToFileURL(resolve(root, 'packages/db/src/a1-store.ts')).href);
  const schema = `test_a1_flow_${crypto.randomUUID().replaceAll('-', '')}`;
  const db = new Database(databaseUrl!, schema);
  let importer: LibraryImporter | undefined;
  try {
    await migrate(db);
    const store: A1Store = new PostgresA1Store(db);
    let now = Date.now(), refreshes = 0, singleTrack = false;
    const config = loadSpotifyConfig({SPOTIFY_CLIENT_ID:'test-client', SPOTIFY_ALLOWED_USER_IDS:'test-owner', TOKEN_ENCRYPTION_KEY:Buffer.alloc(32, 9).toString('base64'), SESSION_SECRET:'integration-test-only-secret-'.repeat(3)});
    const http = new SpotifyHttp({now:() => now, fetch:async (url, init) => {
      if (url.includes('/api/token')) {
        const refresh = new URLSearchParams(init!.body as URLSearchParams).get('grant_type') === 'refresh_token';
        if (refresh) refreshes++;
        return Response.json({access_token:refresh ? 'test-refreshed' : 'test-access', refresh_token:'test-refresh', token_type:'Bearer', expires_in:3600, scope:'user-library-read user-read-private user-read-recently-played'});
      }
      if (url.endsWith('/me')) return Response.json({id:'test-owner', display_name:'Synthetic integration account', images:[]});
      if (url.includes('recently-played')) return Response.json({items:[]});
      const offset = Number(new URL(url).searchParams.get('offset'));
      const ids = singleTrack ? [3] : [1, 2, 3];
      return Response.json({offset, limit:50, total:ids.length, next:offset+2 < ids.length ? 'https://api.spotify.com/v1/me/tracks?offset=2&limit=50' : null, items:ids.slice(offset, offset+2).map(n => ({added_at:singleTrack ? '2026-11-07T00:00:00Z' : '2020-01-01T00:00:00Z', track:{id:String(n).padStart(22, '0'), name:`Synthetic ${n}`, duration_ms:120000, artists:[{id:'test-artist', name:'Synthetic Artist'}]}}))});
    }});
    const auth = new AuthService(config, store, http), start = await auth.start();
    const connected = await auth.callback({state:new URL(start.url).searchParams.get('state')!, code:'test-code'}, start.browserToken);
    const userId = connected.account.user.id;
    let failPage = true;
    const faultStore: A1Store = {
      resumableUserIds:() => store.resumableUserIds(),
      transaction:work => store.transaction(tx => {
        const upsert = tx.upsertSavedTracks.bind(tx);
        tx.upsertSavedTracks = async rows => {
          await upsert(rows);
          if (failPage && rows.some(r => r.track.trackId === '0000000000000000000003')) {
            failPage = false; throw new Error('Injected page failure after SQL upsert');
          }
        };
        return work(tx);
      }),
    };
    importer = new LibraryImporter(faultStore, new SpotifyClient(auth, http), {now:() => now});
    await importer.requestSync(userId); await importer.run(userId);
    expect(await importer.status(userId)).toMatchObject({status:'failed', processed:2, nextOffset:2});
    expect(await importer.summary(userId)).toMatchObject({total:0, remaining:0});
    const partial = await db.transaction((sql: any) => sql`SELECT count(*)::int AS n FROM saved_tracks WHERE user_id=${userId}`);
    expect(partial[0].n).toBe(2); // Failed third row rolled back with its checkpoint.
    await importer.close(); now += 30_001;
    importer = new LibraryImporter(new PostgresA1Store(db), new SpotifyClient(auth, http), {now:() => now});
    await importer.requestSync(userId); await importer.run(userId);
    expect(await importer.status(userId)).toMatchObject({status:'complete', processed:3, total:3});
    expect(await importer.summary(userId)).toMatchObject({total:3, remaining:3});
    // A new connection + services must consume persisted credentials and checkpoint.
    const reconstructed = new AuthService(config, new PostgresA1Store(db), http);
    expect((await reconstructed.session(connected.sessionToken))?.user.spotifyId).toBe('test-owner');
    now += 3_600_000;
    const refreshed = await Promise.all([auth.accessToken(userId), reconstructed.accessToken(userId)]);
    expect(refreshed.map(x => x.token)).toEqual(['test-refreshed', 'test-refreshed']); expect(refreshes).toBe(1);
    singleTrack = true;
    await importer.requestSync(userId); await importer.run(userId);
    expect(await importer.status(userId)).toMatchObject({status:'complete', processed:1, total:1});
    expect(await importer.summary(userId)).toMatchObject({total:1, remaining:1});
    const saved = await db.transaction((sql: any) => sql`SELECT track_id, original_added_at FROM saved_tracks WHERE user_id=${userId} ORDER BY track_id`);
    expect(saved.length).toBe(3);
    expect(new Date(saved[2].original_added_at).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    await auth.logout(connected.sessionToken); expect(await reconstructed.session(connected.sessionToken)).toBeNull();
  } finally {
    await importer?.close();
    // Only this freshly generated test schema is ever removed.
    await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}, 60_000);
