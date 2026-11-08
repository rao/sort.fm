import {FEATURE_VERSION,FeatureValuesSchema,FeatureVectorSchema,IdSchema,TrackCardSchema} from '@sortfm/contracts';
import {Database,PersistenceError,type Transaction} from './client';
import {ready as policyReady} from './policy-core';

const AUDIO_KEYS=['energy','danceability','happiness','acousticness','instrumentalness','liveness','speechiness','tempo_bpm','loudness_db'] as const;
export type ConstellationAudio=Partial<Record<typeof AUDIO_KEYS[number],number|null>>;
export type ConstellationProjection={userId:string;tracks:Array<{id:string;title:string;artist:string;imageUrl:string|null;label:'keep'|'remove'|null;audio:ConstellationAudio}>};
export type ConstellationHistoryProjection={userId:string;membershipSyncedAt:string|null;tracks:Array<ConstellationProjection['tracks'][number]&{isLiked:boolean}>};
const LIMIT=5000;
const unavailable=():never=>{throw new PersistenceError('CONSTELLATION_UNAVAILABLE');};

async function storage(tx:Transaction,userId:string){
 const [r]=await tx`SELECT
  (SELECT count(*)::int FROM unnest(ARRAY['users','tracks','saved_tracks','library_membership','library_state','review_decisions','undo_commands','feedback','calibration_labels','unified_feedback','effective_feedback','exposures','calibration_batches','calibration_batch_items','calibration_batch_exposures','calibration_batch_skips','audio_features','musicae_features','available_audio_features']) n(name) WHERE to_regclass(current_schema()||'.'||name) IS NOT NULL) AS relations,
  (SELECT count(*)::int FROM schema_migrations WHERE name IN ('012_calibration.sql','013_musicae.sql','015_calibration_batch2.sql')) AS migrations,
  EXISTS(SELECT 1 FROM schema_migrations WHERE name='017_calibration_batch3.sql') AS batch3_installed,
  to_regclass(current_schema()||'.calibration_experiments') IS NOT NULL AS batch3_table`;
 if(r.relations!==19||r.migrations!==3||r.batch3_installed!==r.batch3_table)unavailable();
 const policy=await policyReady(tx);
 const [owner]=await tx`SELECT 1 FROM users WHERE id=${userId}`;if(!owner)unavailable();
 // A missing initial assignment must never silently release its identity. This
 // reads identity/provenance only, not frozen feature/prediction/outcome artifacts.
 const invalid=await tx`SELECT 1 FROM calibration_batches b WHERE b.user_id=${userId} AND (
  b.experiment NOT IN ('calibration-batch2-v1','calibration-batch3-v1')
  OR jsonb_typeof(b.snapshot->'selected') IS DISTINCT FROM 'array'
  OR CASE WHEN jsonb_typeof(b.snapshot->'selected')='array' THEN
   jsonb_array_length(b.snapshot->'selected')<>CASE WHEN b.experiment='calibration-batch2-v1' THEN 70 ELSE 60 END
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(b.snapshot->'selected') s WHERE NOT EXISTS(
    SELECT 1 FROM calibration_batch_items i WHERE i.user_id=b.user_id AND i.batch_id=b.batch_id AND i.track_id=s->>'trackId' AND i.assignment=s->>'assignment' AND i.replacement_for IS NULL))
  ELSE false END) LIMIT 1`;
 if(invalid.length)unavailable();
 if(r.batch3_table){
  const bad=await tx`SELECT 1 FROM calibration_batches b LEFT JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=${userId} AND b.experiment='calibration-batch3-v1' AND (x.phase IS NULL OR x.phase NOT IN ('reserved','ready') OR (x.phase='ready' AND (x.seal_receipt IS NULL OR x.seal_request IS NULL))) LIMIT 1`;
  if(bad.length)unavailable();
 }else if((await tx`SELECT 1 FROM calibration_batches WHERE user_id=${userId} AND experiment='calibration-batch3-v1' LIMIT 1`).length)unavailable();
 return {policy,batch3:r.batch3_table as boolean};
}

function audio(normalized:unknown):ConstellationAudio{
 if(normalized===null||normalized===undefined)return {};
 const vector=FeatureVectorSchema.safeParse(normalized);
 // Corrupt or synthetic cached rows are missing observations, never fabricated
 // graph values. No derived metadata, taste centroids or listening fields escape.
 if(!vector.success||!['soundnet','musicae'].includes(vector.data.provenance))return {};
 const result:ConstellationAudio={};for(const key of AUDIO_KEYS){const value=vector.data.values[key];if(value!==undefined)result[key]=FeatureValuesSchema.shape[key].parse(value);}
 return result;
}

/** Structurally implements the additive shared ConstellationReadPort. */
export class PostgresConstellationStore {
 constructor(readonly db:Database){}
 async constellation(userId:string):Promise<ConstellationProjection>{
  try{
   IdSchema.parse(userId);this.db.reviewExclusions?.assertOwner(userId);
   return await this.db.sql.begin('isolation level repeatable read read only',async tx=>{
    await tx.unsafe(`SET LOCAL search_path TO "${this.db.schema}", pg_catalog`);
    await tx.unsafe("SET LOCAL statement_timeout='10s'");
    const installed=await storage(tx,userId),tracks:ConstellationProjection['tracks']=[];
    let after='';
    while(tracks.length<LIMIT){
     const rows=await tx.unsafe(`SELECT s.track_id,t.card,a.normalized,
      CASE WHEN f.split='train' AND NOT f.revoked AND f.label IS NOT NULL AND e.payload->'features'->>'permittedForTraining'='true'
       AND (f.source='calibration' OR (d.result->>'status'='COMPLETE' AND ((f.label=0 AND d.request->>'action'='KEEP') OR (f.label=1 AND d.request->>'action' IN ('ARCHIVE','UNLIKE'))))) THEN f.label ELSE NULL END AS label
      FROM saved_tracks s JOIN tracks t USING(track_id)
      JOIN library_membership m USING(user_id,track_id) JOIN library_state ls ON ls.user_id=s.user_id
      LEFT JOIN effective_feedback f ON f.user_id=s.user_id AND f.track_id=s.track_id
      LEFT JOIN exposures e ON e.user_id=f.user_id AND e.exposure_id=f.exposure_id
      LEFT JOIN review_decisions d ON d.user_id=f.user_id AND d.decision_id=f.decision_id AND f.source='review'
      LEFT JOIN available_audio_features a ON a.track_id=s.track_id AND a.feature_version=$3
      WHERE s.user_id=$1 AND s.track_id COLLATE "C">$2 AND s.current_status IN ('saved','kept','deferred')
       AND t.card->>'source'='spotify' AND s.track_id ~ '^[a-zA-Z0-9]{22}$'
       AND NOT EXISTS(SELECT 1 FROM unified_feedback h WHERE h.user_id=s.user_id AND h.track_id=s.track_id AND h.split='holdout')
       AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=s.user_id AND b.track_id=s.track_id
        AND (b.assignment='sealed_evaluation' OR b.status<>'labeled' OR f.split IS DISTINCT FROM 'train' OR f.label IS NULL OR f.revoked OR e.payload->'features'->>'permittedForTraining' IS DISTINCT FROM 'true'))
       AND NOT EXISTS(SELECT 1 FROM review_decisions p WHERE p.user_id=s.user_id AND p.track_id=s.track_id AND (p.result IS NULL OR p.result->>'status' IN ('PENDING','FAILED_RETRYABLE')))
       AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions ud USING(user_id,decision_id) WHERE u.user_id=s.user_id AND ud.track_id=s.track_id AND u.settled_at IS NULL)
       ${installed.batch3?`AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b JOIN calibration_batches cb USING(user_id,batch_id) JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=s.user_id AND b.track_id=s.track_id AND cb.experiment='calibration-batch3-v1' AND x.phase<>'ready')`:''}
       ${installed.policy?`AND NOT EXISTS(SELECT 1 FROM policy_exposure_bindings p WHERE p.user_id=s.user_id AND p.track_id=s.track_id AND p.closed_at IS NULL AND p.expires_at>statement_timestamp())`:''}
      ORDER BY s.track_id COLLATE "C" LIMIT 5000`,[userId,after,FEATURE_VERSION]);
     for(const r of rows){
      // The optional immutable pilot deny list is private and intentionally has no
      // list accessor. Filter before parsing metadata and before the output cap.
      if(this.db.reviewExclusions?.denies(userId,r.track_id))continue;
      const card=TrackCardSchema.parse(r.card);if(card.trackId!==r.track_id||card.source!=='spotify')unavailable();
      tracks.push({id:card.trackId,title:card.title.slice(0,200),artist:card.artists.map(a=>a.name).join(', ').slice(0,300),imageUrl:card.imageUrl?.startsWith('https://')?card.imageUrl:null,label:r.label===0?'keep':r.label===1?'remove':null,audio:audio(r.normalized)});
      if(tracks.length===LIMIT)break;
     }
     if(rows.length<LIMIT)break;after=rows.at(-1)!.track_id;
    }
    return {userId,tracks};
   }) as ConstellationProjection;
  }catch{throw new PersistenceError('CONSTELLATION_UNAVAILABLE');}
 }
 /** Retained imported history; preference labels never imply library membership. */
 async constellationHistory(userId:string):Promise<ConstellationHistoryProjection>{
  try{
   IdSchema.parse(userId);this.db.reviewExclusions?.assertOwner(userId);
   return await this.db.sql.begin('isolation level repeatable read read only',async tx=>{
    await tx.unsafe(`SET LOCAL search_path TO "${this.db.schema}", pg_catalog`);
    await tx.unsafe("SET LOCAL statement_timeout='10s'");
    const installed=await storage(tx,userId),tracks:ConstellationHistoryProjection['tracks']=[];
    const [state]=await tx`SELECT observed_at FROM library_state WHERE user_id=${userId}`;
    // Without a completed import, absence from membership has no authoritative
    // meaning. observed_at remains the last full import, not a settlement time.
    if(!state)unavailable();
    const membershipSyncedAt=new Date(state.observed_at).toISOString();
    let after='';
    while(tracks.length<LIMIT){
     const rows=await tx.unsafe(`SELECT s.track_id,t.card,a.normalized,(m.track_id IS NOT NULL) AS is_liked,
      CASE WHEN f.split='train' AND NOT f.revoked AND f.label IS NOT NULL AND e.payload->'features'->>'permittedForTraining'='true'
       AND (f.source='calibration' OR (d.result->>'status'='COMPLETE' AND ((f.label=0 AND d.request->>'action'='KEEP') OR (f.label=1 AND d.request->>'action' IN ('ARCHIVE','UNLIKE'))))) THEN f.label ELSE NULL END AS label
      FROM saved_tracks s JOIN tracks t USING(track_id)
      LEFT JOIN library_membership m USING(user_id,track_id)
      LEFT JOIN effective_feedback f ON f.user_id=s.user_id AND f.track_id=s.track_id
      LEFT JOIN exposures e ON e.user_id=f.user_id AND e.exposure_id=f.exposure_id
      LEFT JOIN review_decisions d ON d.user_id=f.user_id AND d.decision_id=f.decision_id AND f.source='review'
      LEFT JOIN available_audio_features a ON a.track_id=s.track_id AND a.feature_version=$3
      WHERE s.user_id=$1 AND s.track_id COLLATE "C">$2
       AND t.card->>'source'='spotify' AND s.track_id ~ '^[a-zA-Z0-9]{22}$'
       AND NOT EXISTS(SELECT 1 FROM unified_feedback h WHERE h.user_id=s.user_id AND h.track_id=s.track_id AND h.split='holdout')
       AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b WHERE b.user_id=s.user_id AND b.track_id=s.track_id
        AND (b.assignment='sealed_evaluation' OR b.status<>'labeled' OR f.split IS DISTINCT FROM 'train' OR f.label IS NULL OR f.revoked OR e.payload->'features'->>'permittedForTraining' IS DISTINCT FROM 'true'))
       AND NOT EXISTS(SELECT 1 FROM review_decisions p WHERE p.user_id=s.user_id AND p.track_id=s.track_id AND (p.result IS NULL OR p.result->>'status' IN ('PENDING','FAILED_RETRYABLE')))
       AND NOT EXISTS(SELECT 1 FROM undo_commands u JOIN review_decisions ud USING(user_id,decision_id) WHERE u.user_id=s.user_id AND ud.track_id=s.track_id AND u.settled_at IS NULL)
       ${installed.batch3?`AND NOT EXISTS(SELECT 1 FROM calibration_batch_items b JOIN calibration_batches cb USING(user_id,batch_id) JOIN calibration_experiments x USING(user_id,batch_id) WHERE b.user_id=s.user_id AND b.track_id=s.track_id AND cb.experiment='calibration-batch3-v1' AND x.phase<>'ready')`:''}
       ${installed.policy?`AND NOT EXISTS(SELECT 1 FROM policy_exposure_bindings p WHERE p.user_id=s.user_id AND p.track_id=s.track_id AND p.closed_at IS NULL AND p.expires_at>statement_timestamp())`:''}
      ORDER BY s.track_id COLLATE "C" LIMIT 5000`,[userId,after,FEATURE_VERSION]);
     for(const r of rows){
      // The optional immutable pilot deny list is private and intentionally has no
      // list accessor. Filter before parsing metadata and before the output cap.
      if(this.db.reviewExclusions?.denies(userId,r.track_id))continue;
      const card=TrackCardSchema.parse(r.card);if(card.trackId!==r.track_id||card.source!=='spotify')unavailable();
      tracks.push({id:card.trackId,title:card.title.slice(0,200),artist:card.artists.map(a=>a.name).join(', ').slice(0,300),imageUrl:card.imageUrl?.startsWith('https://')?card.imageUrl:null,label:r.label===0?'keep':r.label===1?'remove':null,audio:audio(r.normalized),isLiked:r.is_liked});
      if(tracks.length===LIMIT)break;
     }
     if(rows.length<LIMIT)break;after=rows.at(-1)!.track_id;
    }
    return {userId,membershipSyncedAt,tracks};
   }) as ConstellationHistoryProjection;
  }catch{throw new PersistenceError('CONSTELLATION_UNAVAILABLE');}
 }
}
