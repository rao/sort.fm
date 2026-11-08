import {z} from 'zod';
import {SpotifyTrackIdSchema} from '@sortfm/contracts';
import {reviewExclusionManifestDigest,type ReviewExclusionManifest,type Database} from '@sortfm/db';
import type {ApiConfig} from '../config';
import {loadSpotifyConfig} from '../auth/config';
import type {Fetch} from '../spotify/http';
import type {MlFetch} from '../ml';

/** Programmatic opt-in only. The integration lead supplies the independently
 * approved private receipt digest; this module cannot establish its authenticity
 * or the freshness of secrets/artifacts/copied data. No environment auto-enable.
 */
export interface PilotRuntimeOptions {
 manifest:ReviewExclusionManifest;
 approvedManifestSha256:string;
 /** Raw primary OAuth delegate is always wrapped by the endpoint allowlist. */
 oauthFetch?:Fetch;
 /** Separate mutation/reconciliation delegate; requires digest-approved mutation opt-in. */
 mutationFetch?:Fetch;
 /** Test/audited transport; the client still validates the loopback service URL. */
 mlFetch?:MlFetch;
}
const manifestSchema=z.strictObject({ownerId:z.string().startsWith('spotify:').min(9),pilotSchema:z.string().regex(/^pilot_c2_[a-f0-9]{24}$/),sortedTrackIds:z.array(SpotifyTrackIdSchema).max(100000),sha256:z.string().regex(/^[a-f0-9]{64}$/),allowSpotifyMutations:z.boolean().optional()});
const loopback=(value:string)=>{const url=new URL(value);if(url.origin!==value||!['http:','https:'].includes(url.protocol)||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.port==='0')throw Error();return url;};
export function validatePilotRuntime(env:Record<string,string|undefined>,config:ApiConfig,options:PilotRuntimeOptions):PilotRuntimeOptions {
 try{
  const manifest=manifestSchema.parse(options.manifest);
  if(options.mutationFetch && manifest.allowSpotifyMutations!==true)throw Error();
  if(manifest.sha256!==options.approvedManifestSha256 || manifest.sha256!==reviewExclusionManifestDigest(manifest)
   || manifest.sortedTrackIds.some((id,i)=>i>0&&id<=manifest.sortedTrackIds[i-1]!) || env.DATABASE_SCHEMA!==manifest.pilotSchema
   || !env.DATABASE_URL?.trim() || config.demoEnabled || env.DEMO_MODE_ENABLED!=='false')throw Error();
  const api=loopback(config.apiOrigin);loopback(config.webOrigin);loopback(env.ML_SERVICE_URL??'');
  if(new Set([config.apiOrigin,config.webOrigin,env.ML_SERVICE_URL]).size!==3 || config.host!==(api.hostname==='[::1]'?'::1':api.hostname)
   || config.port!==Number(api.port||(api.protocol==='https:'?443:80)) || env.ML_ALLOW_RAILWAY_PRIVATE_HTTP==='true')throw Error();
  const owners=(env.SPOTIFY_ALLOWED_USER_IDS??'').split(',').map(x=>x.trim());
  if(owners.length!==1 || manifest.ownerId!==`spotify:${owners[0]}`)throw Error();
  for(const key of ['TOKEN_ENCRYPTION_KEY','SESSION_SECRET','ML_SERVICE_SHARED_SECRET'])if(!env[key]?.trim() || env[key]!.length<32)throw Error();
  if(new Set([env.TOKEN_ENCRYPTION_KEY,env.SESSION_SECRET,env.ML_SERVICE_SHARED_SECRET]).size!==3)throw Error();
  loadSpotifyConfig(env); // Includes encryption key, callback and session validation.
  return {...options,manifest}; // Zod owns the copied manifest/IDs across startup awaits.
 }catch{throw new Error('PILOT_CONFIG_INVALID');}
}

/** Read-only startup probes. Partial/misplaced policy storage must not trigger the
 * legacy QueueService fallback or start workers. Migrations stay operator-owned.
 */
export async function assertPilotStorage(database:Database):Promise<void> {
 await database.transaction(async tx=>{
  const [schema]=await tx`SELECT current_schema() AS name`;
  if(schema?.name!==database.schema || !database.reviewExclusions)throw Error('PILOT_STORAGE_UNAVAILABLE');
  // The wrapper's search_path also includes public for normal deployments. Every
  // runtime relation must exist in this schema so a partial copy cannot resolve
  // an unqualified worker query into a different schema.
  const [relations]=await tx`SELECT count(*)::integer AS missing FROM unnest(ARRAY[
   'schema_migrations','users','oauth_credentials','auth_sessions','oauth_attempts','tracks','saved_tracks',
   'library_snapshots','taste_context','exposures','review_decisions','current_decisions','undo_commands',
   'spotify_mutations','feedback','archive_playlists','archive_records','import_jobs','audio_features',
   'soundnet_jobs','provider_limits','provider_smoke','model_runs','interaction_events','ml_telemetry',
   'library_membership','library_state','soundnet_failures','feedback_sync_jobs','review_work',
   'review_work_leases','review_effects','exposure_consumptions','soundnet_attempts','calibration_labels',
   'calibration_undos','unified_feedback','effective_feedback','ml_training_examples','musicae_requests',
   'musicae_jobs','musicae_features','musicae_control','available_audio_features','playback_grants',
   'playback_oauth_attempts','calibration_batches','calibration_batch_items','calibration_batch_exposures',
   'calibration_batch_skips','policy_owner_state','policy_fit_receipts','policy_selection_intents',
   'policy_exposure_bindings','policy_release_commands','policy_delivery_events'
  ]) AS t(name) WHERE to_regclass(current_schema()||'.'||t.name) IS NULL`;
  if(relations?.missing!==0)throw Error('PILOT_STORAGE_UNAVAILABLE');
  const foreign=await tx`SELECT 1 FROM users WHERE id<>${database.reviewExclusions.ownerId} LIMIT 1`;
  if(foreign.length)throw Error('PILOT_STORAGE_UNAVAILABLE');
  await tx`SELECT user_id,sequence FROM policy_owner_state LIMIT 0`;
  await tx`SELECT user_id,model_version,feedback_revision,recorded_at FROM policy_fit_receipts LIMIT 0`;
  await tx`SELECT user_id,request_id,fingerprint,draft,feedback_revision,membership_revision,created_at,expires_at,status,lease_id,lease_until,lease_started_at,publication FROM policy_selection_intents LIMIT 0`;
  await tx`SELECT exposure_id,user_id,request_id,track_id,published,reserved_at,expires_at,closed_at,closure_reason FROM policy_exposure_bindings LIMIT 0`;
  await tx`SELECT user_id,release_id,request_id,fingerprint,receipt FROM policy_release_commands LIMIT 0`;
  await tx`SELECT event_id,user_id,sequence,dedupe_key,kind,payload,request_id,exposure_id,created_at,available_at,attempts,lease_id,lease_until,lease_started_at,worker_id,claimed_fit_receipt,completed_at,receipt,disposition,error_code FROM policy_delivery_events LIMIT 0`;
 });
}
