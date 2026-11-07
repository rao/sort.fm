import {test,expect} from 'bun:test';
import {readdir,readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {join} from 'node:path';
import {Database} from '../src/client';import {migrate} from '../src/migrate';import {Repository} from '../src/repository';import {createDemoQueue,demoTracks} from '@sortfm/contracts/fixtures';
const url=process.env.TEST_DATABASE_URL;
test.skipIf(!url)('calibration migration backfills legacy exposure purpose, rolls back atomically and reapplies once',async()=>{
 const db=new Database(url!,`test_cal_migrate_${crypto.randomUUID().replaceAll('-','')}`),directory=join(import.meta.dir,'../migrations');
 try{
  await db.sql.unsafe(`CREATE SCHEMA "${db.schema}"`);
  await db.transaction(async tx=>{await tx`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n<'012').sort()){const body=await readFile(join(directory,name),'utf8');await tx.unsafe(body);await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${createHash('sha256').update(body).digest('hex')})`;}});
  const repo=new Repository(db),userId='test:legacy';await repo.upsertUser({id:userId,spotifyId:null,displayName:'Legacy',avatarUrl:null});const track=demoTracks[0]!;
  await repo.upsertSavedTracks([{userId,track,originalAddedAt:track.originalAddedAt,syncedAt:new Date().toISOString(),currentStatus:'saved'}]);
  const item=createDemoQueue({limit:1,exposureId:()=>crypto.randomUUID()}).items[0]!,input={userId,exposure:item.exposure,prediction:item.prediction,features:{featureVersion:'sortfm.features.v1',values:{energy:null},provenance:'synthetic',permittedForTraining:true}};
  // Legacy insert intentionally predates the new purpose-aware repository operation.
  await db.transaction(tx=>tx`INSERT INTO exposures(exposure_id,user_id,track_id,payload,served_at) VALUES(${item.exposure.exposureId},${userId},${track.trackId},${JSON.stringify(input)}::jsonb,${item.exposure.servedAt})`);
  const body=await readFile(join(directory,'012_calibration.sql'),'utf8');await expect(db.transaction(async tx=>{await tx.unsafe(body);throw new Error('INJECTED_ROLLBACK');})).rejects.toThrow('INJECTED_ROLLBACK');
  expect(await db.transaction(tx=>tx`SELECT 1 FROM information_schema.columns WHERE table_schema=${db.schema} AND table_name='exposures' AND column_name='purpose'`)).toHaveLength(0);
  expect((await migrate(db)).applied).toEqual(['012_calibration.sql','013_musicae.sql']);expect((await migrate(db)).applied).toEqual([]);
  const [legacy]=await db.transaction(tx=>tx`SELECT purpose,payload FROM exposures WHERE exposure_id=${item.exposure.exposureId}`);expect(legacy.purpose).toBe('review');expect(legacy.payload).toEqual(input);
 }finally{await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},60000);
