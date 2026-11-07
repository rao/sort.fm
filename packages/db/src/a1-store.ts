import type {A1Store,A1Transaction,Account,Session,OAuthAttempt,ImportJob,ImportObservation,ImportMembership,TasteContext,LibrarySummary} from '@sortfm/contracts';
import {AccountSessionSchema,LibraryImportStatusSchema,type SavedTrackInput} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';import {upsertSavedTracks} from './repository';
function encrypted(value:string){if(!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(value))throw new PersistenceError('ENCRYPTED_CREDENTIAL_REQUIRED');}
/** A1 seals access/refresh tokens and PKCE verifier before calling this store. Never accepts plaintext. */
export class PostgresA1Store implements A1Store {
 constructor(readonly db:Database){}
 async transaction<T>(work:(tx:A1Transaction)=>Promise<T>):Promise<T>{
  // A1 callbacks perform only transactional DB operations. Retry only definite rollbacks,
  // never ambiguous connection/commit errors, and never callbacks containing network I/O.
  for(let attempt=0;;attempt++)try{return await this.db.transaction(tx=>work(new PostgresA1Transaction(tx)),true);}catch(error){
   const e=error as {errno?:string;code?:string;sqlState?:string};
   if(attempt>=3||![e.errno,e.code,e.sqlState].some(c=>c==='40001'||c==='40P01'))throw error;
   await Bun.sleep(25*2**attempt+Math.random()*25);
  }
 }
 async resumableUserIds():Promise<string[]>{return this.db.transaction(async tx=>(await tx`SELECT user_id FROM import_jobs WHERE job_type='library' AND (payload->'progress'->>'status' IN ('pending','running') OR (payload->'progress'->>'status'='failed' AND payload->'progress'->'error'->>'retryable'='true')) ORDER BY user_id`).map((r:any)=>r.user_id));}
}
class PostgresA1Transaction implements A1Transaction {
 constructor(readonly tx:Transaction){}
 async getAccount(userId:string):Promise<Account|null>{const [r]=await this.tx`SELECT encrypted_payload FROM oauth_credentials WHERE user_id=${userId} FOR UPDATE`;return r?JSON.parse(r.encrypted_payload):null;}
 async putAccount(account:Account){
  AccountSessionSchema.shape.user.unwrap().parse(account.user);if(!account.revoked||account.accessToken)encrypted(account.accessToken);if(!account.revoked||account.refreshToken)encrypted(account.refreshToken);
  const p=account.user;
  const rows=await this.tx`INSERT INTO users(id,spotify_user_id,profile,is_authorized) VALUES(${p.id},${p.spotifyId},${json(p)}::jsonb,${!account.revoked}) ON CONFLICT(id) DO UPDATE SET profile=excluded.profile,is_authorized=excluded.is_authorized WHERE users.spotify_user_id IS NOT DISTINCT FROM excluded.spotify_user_id RETURNING id`;
  if(!rows.length)throw new PersistenceError('ACCOUNT_IDENTITY_CONFLICT');
  await this.tx`INSERT INTO oauth_credentials(user_id,encrypted_payload) VALUES(${p.id},${json(account)}) ON CONFLICT(user_id) DO UPDATE SET encrypted_payload=excluded.encrypted_payload,updated_at=now()`;
 }
 async getSession(hash:string):Promise<Session|null>{const [r]=await this.tx`SELECT * FROM auth_sessions WHERE hash=${hash} FOR UPDATE`;return r?{hash:r.hash,userId:r.user_id,expiresAt:new Date(r.expires_at).getTime()}:null;}
 async putSession(v:Session){await this.tx`INSERT INTO auth_sessions(hash,user_id,expires_at) VALUES(${v.hash},${v.userId},${new Date(v.expiresAt).toISOString()}) ON CONFLICT(hash) DO UPDATE SET expires_at=excluded.expires_at WHERE auth_sessions.user_id=excluded.user_id`;}
 async deleteSession(hash:string){await this.tx`DELETE FROM auth_sessions WHERE hash=${hash}`;}
 async deleteSessions(userId:string){await this.tx`DELETE FROM auth_sessions WHERE user_id=${userId}`;}
 async getOAuth(stateHash:string):Promise<OAuthAttempt|null>{const [r]=await this.tx`SELECT encrypted_payload FROM oauth_attempts WHERE state_hash=${stateHash} FOR UPDATE`;return r?JSON.parse(r.encrypted_payload):null;}
 async putOAuth(v:OAuthAttempt){encrypted(v.verifier);await this.tx`INSERT INTO oauth_attempts(state_hash,encrypted_payload,expires_at) VALUES(${v.stateHash},${json(v)},${new Date(v.expiresAt).toISOString()}) ON CONFLICT DO NOTHING`;}
 async deleteOAuth(stateHash:string){await this.tx`DELETE FROM oauth_attempts WHERE state_hash=${stateHash}`;}
 async getJob(userId:string):Promise<ImportJob|null>{return (await this.tx`SELECT payload FROM import_jobs WHERE user_id=${userId} AND job_type='library' FOR UPDATE`)[0]?.payload??null;}
 async putJob(v:ImportJob){LibraryImportStatusSchema.parse(v.progress);await this.tx`INSERT INTO import_jobs(user_id,job_type,payload) VALUES(${v.userId},'library',${json(v)}::jsonb) ON CONFLICT(user_id,job_type) DO UPDATE SET payload=excluded.payload,updated_at=now()`;}
 upsertSavedTracks(rows:SavedTrackInput[]){return upsertSavedTracks(this.tx,rows);}
 async putObservations(rows:ImportObservation[]){for(const v of rows){
  const inserted=await this.tx`INSERT INTO library_snapshots(user_id,job_id,pass,page_offset,observation) VALUES(${v.userId},${v.jobId},${v.pass},${v.offset},${json(v)}::jsonb) ON CONFLICT DO NOTHING RETURNING user_id`;
  if(!inserted.length){const [same]=await this.tx`SELECT 1 FROM library_snapshots WHERE user_id=${v.userId} AND job_id=${v.jobId} AND pass=${v.pass} AND page_offset=${v.offset} AND observation=${json(v)}::jsonb`;if(!same)throw new PersistenceError('OBSERVATION_CONFLICT');}
 }}
 async completeImportMembership(v:ImportMembership){
  if(!Number.isInteger(v.sourceTotal)||v.sourceTotal<0||new Set(v.trackIds).size>v.sourceTotal)throw new PersistenceError('INVALID_MEMBERSHIP');
  await this.tx`SELECT id FROM users WHERE id=${v.userId} FOR UPDATE`;
  const [state]=await this.tx`SELECT * FROM library_state WHERE user_id=${v.userId}`;
  if(state && (new Date(state.observed_at).getTime()>Date.parse(v.observedAt)||(state.job_id===v.jobId&&state.pass>v.pass)))throw new PersistenceError('STALE_IMPORT');
  await this.tx`DELETE FROM library_membership WHERE user_id=${v.userId}`;
  // FK guarantees every known member already has its durable metadata/snapshot.
  await this.tx`INSERT INTO library_membership(user_id,track_id,job_id,pass) SELECT ${v.userId},value,${v.jobId},${v.pass} FROM jsonb_array_elements_text(${json([...new Set(v.trackIds)])}::jsonb)`;
  await this.tx`INSERT INTO library_state(user_id,job_id,pass,source_total,observed_at) VALUES(${v.userId},${v.jobId},${v.pass},${v.sourceTotal},${v.observedAt}) ON CONFLICT(user_id) DO UPDATE SET job_id=excluded.job_id,pass=excluded.pass,source_total=excluded.source_total,observed_at=excluded.observed_at`;
 }
 async getSummary(userId:string):Promise<LibrarySummary>{
  const [row]=await this.tx`SELECT
   COALESCE((SELECT source_total FROM library_state WHERE user_id=${userId}),0)::int AS total,
   (SELECT count(*)::int FROM library_membership m JOIN saved_tracks s USING(user_id,track_id) JOIN tracks t USING(track_id) WHERE m.user_id=${userId} AND s.current_status IN('saved','deferred') AND t.card->>'isPlayable'='true') AS remaining,
   count(*) FILTER(WHERE d.result->>'status'='COMPLETE')::int AS reviewed,
   count(*) FILTER(WHERE d.result->>'status'='COMPLETE' AND d.result->>'action'='ARCHIVE')::int AS archived,
   count(*) FILTER(WHERE d.result->>'status'='COMPLETE' AND d.result->>'action'='UNLIKE')::int AS unliked,
   count(*) FILTER(WHERE d.result->>'status'='COMPLETE' AND d.result->>'action'='KEEP')::int AS kept,
   count(*) FILTER(WHERE d.result->>'status'='COMPLETE' AND d.result->>'action'='SKIP')::int AS skipped
   FROM current_decisions c JOIN review_decisions d USING(user_id,decision_id) WHERE c.user_id=${userId}`;
  return row as LibrarySummary;
 }
 async putTasteContext(v:TasteContext){await this.tx`INSERT INTO taste_context(user_id,context) VALUES(${v.userId},${json(v)}::jsonb) ON CONFLICT(user_id) DO UPDATE SET context=excluded.context`;}
}
