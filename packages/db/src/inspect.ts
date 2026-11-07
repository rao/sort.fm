import {connectDatabase} from './client';
const db=connectDatabase();
try {
 const report=await db.transaction(async tx=>{
  const migrations=await tx`SELECT name,applied_at FROM schema_migrations ORDER BY name`;
  const [counts]=await tx`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM tracks) AS tracks,(SELECT count(*)::int FROM ml_telemetry) AS telemetry_events,(SELECT count(*)::int FROM audio_features) AS cached_features`;
  const [ext]=await tx`SELECT extversion FROM pg_extension WHERE extname='timescaledb'`;
  let hypertable=false;
  if(ext){const [h]=await tx`SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_schema=${db.schema} AND hypertable_name='ml_telemetry'`;hypertable=Boolean(h);}
  const buckets=await tx`SELECT date_trunc('minute',occurred_at) AS bucket,event_type,count(*)::int AS events FROM ml_telemetry GROUP BY 1,2 ORDER BY 1 DESC LIMIT 5`;
  return {schema:db.schema,migrations,counts,timescaleVersion:ext?.extversion??null,hypertable,buckets};
 });console.log(JSON.stringify(report,null,2));
}catch{console.error('DATABASE_INSPECTION_FAILED');process.exitCode=1;}finally{await db.close();}
