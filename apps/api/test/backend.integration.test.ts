import {expect,test} from 'bun:test';
import {Database,migrate,Repository} from '@sortfm/db';
import {QueueResultSchema,AccountSessionSchema,LibraryImportStatusSchema} from '@sortfm/contracts';
import {buildRuntime} from '../src/runtime';
import {SpotifyHttp} from '../src/spotify/http';

const databaseUrl=process.env.TEST_DATABASE_URL;

test.skipIf(!databaseUrl)('HTTP OAuth and import reach Tiger and produce durable review queue exposures',async()=>{
 const schema=`test_backend_${crypto.randomUUID().replaceAll('-','')}`;
 const db=new Database(databaseUrl!,schema);
 let runtime:Awaited<ReturnType<typeof buildRuntime>>|undefined;
 const tracks=[1,2,3].map(n=>({added_at:'2020-01-01T00:00:00Z',track:{id:String(n).padStart(22,'0'),name:`Controlled backend track ${n}`,duration_ms:120000,is_playable:true,artists:[{id:`artist-${n}`,name:`Controlled Artist ${n}`}],album:{name:'Controlled album',release_date:'2019-01-01',images:[]}}}));
 const http=new SpotifyHttp({fetch:async url=>{
  if(url.includes('/api/token'))return Response.json({access_token:'controlled-access',refresh_token:'controlled-refresh',token_type:'Bearer',expires_in:3600,scope:'user-library-read user-read-private user-read-recently-played'});
  if(url.endsWith('/me'))return Response.json({id:'controlled-owner',display_name:'Controlled backend account',images:[]});
  if(url.includes('recently-played'))return Response.json({items:[]});
  if(url.includes('/me/tracks'))return Response.json({offset:0,limit:50,total:tracks.length,next:null,items:tracks});
  throw new Error('Unexpected controlled-provider request');
 }});
 try {
  await migrate(db);
  runtime=await buildRuntime({env:{NODE_ENV:'test',DATABASE_URL:databaseUrl,DATABASE_SCHEMA:schema,SPOTIFY_CLIENT_ID:'controlled-client',SPOTIFY_ALLOWED_USER_IDS:'controlled-owner',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,8).toString('base64'),SESSION_SECRET:'controlled-backend-test-only-'.repeat(3)},spotifyHttp:http});
  expect(runtime.startupIssues).toEqual([]);
  const base=await runtime.app.listen({host:'127.0.0.1',port:0});
  const start=await fetch(`${base}/api/auth/spotify/start`,{redirect:'manual'});
  expect(start.status).toBe(302);
  const state=new URL(start.headers.get('location')!).searchParams.get('state')!;
  const oauthCookie=start.headers.get('set-cookie')!.split(';')[0]!;
  const callback=await fetch(`${base}/api/auth/spotify/callback?${new URLSearchParams({state,code:'controlled-code'})}`,{headers:{cookie:oauthCookie},redirect:'manual'});
  expect(callback.status).toBe(302);
  const sessionCookie=callback.headers.getSetCookie().find(value=>value.startsWith('sortfm_session='))!.split(';')[0]!;
  const session=AccountSessionSchema.parse(await(await fetch(`${base}/api/me`,{headers:{cookie:sessionCookie}})).json());
  expect(session.mode).toBe('spotify');expect(session.user?.spotifyId).toBe('controlled-owner');
  const sync=await fetch(`${base}/api/library/sync`,{method:'POST',headers:{cookie:sessionCookie,origin:'http://127.0.0.1:5173','content-type':'application/json'},body:'{}'});
  expect(sync.status).toBe(202);
  let status=LibraryImportStatusSchema.parse(await sync.json());
  const deadline=Date.now()+25_000;
  while(status.status!=='complete'&&status.status!=='failed'&&Date.now()<deadline){
   await Bun.sleep(100);
   status=LibraryImportStatusSchema.parse(await(await fetch(`${base}/api/library/sync/status`,{headers:{cookie:sessionCookie}})).json());
  }
  expect(status.status).toBe('complete');expect(status.processed).toBe(3);
  const result=await fetch(`${base}/api/queue?limit=3`,{headers:{cookie:sessionCookie}});
  expect(result.status).toBe(200);
  const queue=QueueResultSchema.parse(await result.json());
  expect(queue.mode).toBe('spotify');expect(queue.items).toHaveLength(3);expect(queue.remaining).toBe(3);
  const repository=new Repository(db);
  const rows=await repository.library(session.user!.id);
  expect(rows.every(row=>row.audioFeatures===null)).toBe(true);
  for(const item of queue.items){
   const stored=await repository.getExposure(session.user!.id,item.exposure.exposureId);
   expect(stored?.prediction).toEqual(item.prediction);
   expect(stored?.features.values.saved_age_days).toBeGreaterThan(0);
   expect(item.prediction.removalProbability).toBeNull();
   expect(await repository.getExposure('other-user',item.exposure.exposureId)).toBeNull();
  }
  expect((await fetch(`${base}/api/queue`)).status).toBe(401);
  const demo=QueueResultSchema.parse(await(await fetch(`${base}/api/queue?mode=demo&limit=1`)).json());
  expect(demo.items[0]?.track.source).toBe('synthetic');
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
 } finally {
  await runtime?.close();
  await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db.close();
 }
},60_000);
