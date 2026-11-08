import {test,expect} from 'bun:test';import {readdir,readFile} from 'node:fs/promises';import {join} from 'node:path';import {createHash} from 'node:crypto';import {Database} from '../src/client';import {migrate} from '../src/migrate';import {PostgresCalibrationExperimentStore} from '../src/calibration-experiment';import {Repository} from '../src/repository';
const url=process.env.TEST_DATABASE_URL;
test.skipIf(!url)('017 rolls back cleanly, reapplies idempotently and preserves old tables and vectors',async()=>{
 const db=new Database(url!,`test_batch3_migration_${crypto.randomUUID().replaceAll('-','')}`),dir=join(import.meta.dir,'../migrations');
 try{
  await db.sql.unsafe(`CREATE SCHEMA "${db.schema}"`);await db.transaction(async tx=>{await tx`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;for(const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')&&n<'017').sort()){const body=await readFile(join(dir,name),'utf8');await tx.unsafe(body);await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${createHash('sha256').update(body).digest('hex')})`;}});
  const repo=new Repository(db);await repo.upsertUser({id:'test:migration',spotifyId:null,displayName:'Synthetic',avatarUrl:null});
  await expect(new PostgresCalibrationExperimentStore(db).calibrationExperimentSnapshot('test:migration','calibration-batch3-v1')).rejects.toThrow('BATCH_UNAVAILABLE');
  const tables=await db.transaction(tx=>tx`SELECT table_name FROM information_schema.tables WHERE table_schema=${db.schema} AND table_name<>'schema_migrations' ORDER BY table_name`);
  const snapshot=()=>db.transaction(async tx=>{const result:Record<string,string>={};for(const t of tables){if(!/^[a-z_]+$/.test(t.table_name))throw Error('UNSAFE_IDENTIFIER');result[t.table_name]=(await tx.unsafe(`SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM "${t.table_name}" t`))[0].hash;}return result;});
  const before=await snapshot(),body=await readFile(join(dir,'017_calibration_batch3.sql'),'utf8');
  await expect(db.transaction(async tx=>{await tx.unsafe(body);throw Error('TEST_ROLLBACK');})).rejects.toThrow('TEST_ROLLBACK');expect(await snapshot()).toEqual(before);
  expect(await db.transaction(tx=>tx`SELECT 1 FROM information_schema.tables WHERE table_schema=${db.schema} AND table_name='calibration_experiments'`)).toHaveLength(0);
  expect((await migrate(db)).applied).toEqual(['017_calibration_batch3.sql']);expect((await migrate(db)).applied).toEqual([]);expect(await snapshot()).toEqual(before);
 }finally{await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${db.schema}" CASCADE`);await db.close();}
},120000);
