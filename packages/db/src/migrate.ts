import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {connectDatabase, type Database} from './client';
export async function migrate(db:Database) {
 const directory=join(import.meta.dir,'../migrations');
 return db.sql.begin(async tx=>{
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`sortfm:migrate:${db.schema}`}))`;
  await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
  await tx.unsafe(`SET LOCAL search_path TO "${db.schema}", public`);
  await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied:string[]=[];
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort()) {
   const body=await Bun.file(join(directory,name)).text();const checksum=createHash('sha256').update(body).digest('hex');
   const [old]=await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
   if(old){if(old.checksum!==checksum) throw new Error('MIGRATION_CHECKSUM_MISMATCH');continue;}
   await tx.unsafe(body);await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;applied.push(name);
  }
  // Never install extensions automatically; ordinary PostgreSQL is a supported fallback.
  const [ext]=await tx`SELECT 1 FROM pg_extension WHERE extname='timescaledb'`;
  let hypertable=false;
  if(ext) {
   await tx.savepoint(async st=>{await st`SELECT create_hypertable(${`${db.schema}.ml_telemetry`}::regclass,'occurred_at',if_not_exists=>true,migrate_data=>true)`;hypertable=true;}).catch(()=>{});
  }
  return {applied,hypertable};
 });
}
if(import.meta.main){const db=connectDatabase();try{console.log(await migrate(db));}catch{console.error('Migration failed; inspect database diagnostics securely.');process.exitCode=1;}finally{await db.close();}}
