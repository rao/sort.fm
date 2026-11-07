import {test,expect,describe,beforeAll,afterAll} from 'bun:test';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {PostgresA1Store} from '../src/a1-store';import {Repository} from '../src/repository';
import {demoTracks} from '@sortfm/contracts/fixtures';import type {Account} from '@sortfm/contracts';
const url=process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('A1 persistence port',()=>{
 const db=new Database(url!,`test_a1_${crypto.randomUUID().replaceAll('-','')}`);const store=new PostgresA1Store(db);const userId='test:a1';const jobId=crypto.randomUUID();const now=new Date().toISOString();
 const envelope='v1.'+Buffer.alloc(12).toString('base64url')+'.'+Buffer.alloc(16).toString('base64url')+'.ciphertext';
 const account:Account={user:{id:userId,spotifyId:null,displayName:'Test',avatarUrl:null},accessToken:envelope,refreshToken:envelope,expiresAt:Date.now()+1000,scopes:[],credentialVersion:crypto.randomUUID(),revoked:false,refreshLease:null};
 // Cloud DDL/cleanup can exceed the unit-test default under shared pool load.
 beforeAll(async()=>{await migrate(db);},30_000);afterAll(async()=>{await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();},30_000);
 test('encrypted fields, detached reads and rollback',async()=>{
  await expect(store.transaction(tx=>tx.putAccount({...account,accessToken:'plaintext'}))).rejects.toThrow('ENCRYPTED_CREDENTIAL_REQUIRED');
  await store.transaction(tx=>tx.putAccount(account));
  await expect(store.transaction(async tx=>{await tx.putSession({hash:'rollback',userId,expiresAt:Date.now()+10000});throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await store.transaction(tx=>tx.getSession('rollback'))).toBeNull();
  const detached=(await store.transaction(tx=>tx.getAccount(userId)))!;detached.scopes.push('bad');expect((await store.transaction(tx=>tx.getAccount(userId)))!.scopes).toEqual([]);
 });
 test('completed membership replaces current set, partial import never erases history or publishes removals',async()=>{
  await store.transaction(async tx=>{
   await tx.upsertSavedTracks(demoTracks.slice(0,2).map(track=>({userId,track:{...track,isPlayable:true},originalAddedAt:track.originalAddedAt,syncedAt:now,currentStatus:'saved'})));
   await tx.completeImportMembership({userId,jobId,pass:0,trackIds:demoTracks.slice(0,2).map(t=>t.trackId),sourceTotal:3,observedAt:now});
  });
  expect(await store.transaction(tx=>tx.getSummary(userId))).toMatchObject({total:3,remaining:2});
  await store.transaction(tx=>tx.upsertSavedTracks([{userId,track:{...demoTracks[0]!,isPlayable:true},originalAddedAt:now,syncedAt:now,currentStatus:'saved'}]));
  expect((await store.transaction(tx=>tx.getSummary(userId))).remaining).toBe(2);
  await store.transaction(tx=>tx.completeImportMembership({userId,jobId,pass:1,trackIds:[demoTracks[0]!.trackId],sourceTotal:1,observedAt:now}));
  expect((await store.transaction(tx=>tx.getSummary(userId))).remaining).toBe(1);
  expect((await new Repository(db).library(userId)).length).toBe(1);
  await store.transaction(tx=>tx.completeImportMembership({userId,jobId,pass:2,trackIds:[],sourceTotal:0,observedAt:now}));
  expect((await store.transaction(tx=>tx.getSummary(userId))).total).toBe(0);
  expect((await new Repository(db).library(userId)).length).toBe(0);expect((await new Repository(db).library(userId,true)).length).toBe(2);
  const [saved]=await db.transaction(tx=>tx`SELECT count(*)::int AS n,min(original_added_at) AS original FROM saved_tracks WHERE user_id=${userId}`);expect(saved.n).toBe(2);expect(new Date(saved.original).toISOString()).toBe(demoTracks[0]!.originalAddedAt);
 });
 test('observations dedupe within each import pass and preserve invalid entries',async()=>{
  const observation={userId,jobId,pass:0,offset:0,raw:{track:null},reason:'null_track' as const,trackId:null,observedAt:now};
  await store.transaction(async tx=>{await tx.putObservations([observation,observation,{...observation,pass:1}]);});
  const [count]=await db.transaction(tx=>tx`SELECT count(*)::int AS n FROM library_snapshots`);expect(count.n).toBe(2);
 });
 test('serializable concurrent account updates retry definite rollbacks',async()=>{
  await Promise.all(Array.from({length:3},(_,i)=>store.transaction(async tx=>{
   const current=(await tx.getAccount(userId))!;await Bun.sleep(10);await tx.putAccount({...current,scopes:[...current.scopes,String(i)]});
  })));
  expect((await store.transaction(tx=>tx.getAccount(userId)))!.scopes).toHaveLength(3);
 });

});
