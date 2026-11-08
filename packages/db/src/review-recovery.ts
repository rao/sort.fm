import {assertPilotDecision} from './review-exclusions';
import type {ReviewResult,MutationTransitionInput,UndoCommandInput} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';
export type ReviewLeaseIdentity={userId:string;leaseId:string};
export type MutationSnapshot=Omit<MutationTransitionInput,'expectedStatus'>;
export type ReviewWorkLease=ReviewLeaseIdentity & {decisionId:string;operation:'review'|'undo';commandId:string;result:ReviewResult;mutation:MutationSnapshot|null};
export type ReviewEffectRequest={kind:'create_archive';name:string;public:false;description:string}|{kind:'add_archive';playlistId:string;trackId:string};
export type ReviewEffect={request:ReviewEffectRequest;state:'intent'|'confirmed'|'retryable';remoteId:string|null};
const fail=(code:string):never=>{throw new PersistenceError(code);};
const snapshot=(row:any):MutationSnapshot|null=>row?{mutationId:row.mutation_id,userId:row.user_id,decisionId:row.decision_id,status:row.status,step:row.step,attempts:row.attempts,archivePlaylistId:row.archive_playlist_id,occurredAt:new Date(row.updated_at).toISOString()}:null;
const effect=(row:any):ReviewEffect=>({request:row.request,state:row.state,remoteId:row.remote_id});
function duration(ms:number){if(!Number.isInteger(ms)||ms<1||ms>600000)fail('INVALID_REVIEW_LEASE');}
function validTime(ms:number){if(!Number.isFinite(ms)||!Number.isFinite(new Date(ms).getTime()))fail('INVALID_RETRY_TIME');}
/** All review writers use this same owner lock, including legacy callers. */
export async function assertReviewLease(tx:Transaction,userId:string,decisionId:string|null,lease?:ReviewLeaseIdentity){
 const [owner]=await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;if(!owner)fail('USER_NOT_FOUND');
 const [row]=await tx`SELECT l.*,w.decision_id,w.operation FROM review_work_leases l JOIN review_work w USING(user_id,command_id) WHERE l.user_id=${userId} AND l.lease_until>clock_timestamp()`;
 if(!lease){if(row)fail('REVIEW_LEASE_REQUIRED');return null;}
 if(lease.userId!==userId||!row||row.lease_id!==lease.leaseId||(decisionId!==null&&row.decision_id!==decisionId))fail('REVIEW_LEASE_LOST');
 return row;
}
async function active(tx:Transaction,userId:string,leaseId:string){
 await tx`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
 return (await tx`SELECT l.*,w.decision_id,w.operation FROM review_work_leases l JOIN review_work w USING(user_id,command_id) WHERE l.user_id=${userId} AND l.lease_id=${leaseId} AND l.lease_until>clock_timestamp()`)[0]??null;
}
function effectKey(row:any,kind:ReviewEffectRequest['kind']){if(!['create_archive','add_archive'].includes(kind))fail('INVALID_REVIEW_EFFECT');return kind==='create_archive'?kind:`add_archive:${row.decision_id}`;}
/** Internal data-access seam only; API worker owns Spotify transport and reconciliation. */
export class ReviewRecoveryRepository {
 constructor(readonly db:Database){}
 async claimReviewWork(workerId:string,now:number,leaseMs:number):Promise<ReviewWorkLease|null>{
  duration(leaseMs);validTime(now);if(!workerId||workerId.length>128)fail('INVALID_REVIEW_LEASE');
  return this.db.transaction(async tx=>{
   // Lock the owner first, consistently with command creation and settlement. SKIP LOCKED permits independent users.
   const [owner]=await tx`SELECT u.id FROM users u WHERE (${this.db.reviewExclusions?.ownerId??null}::text IS NULL OR u.id=${this.db.reviewExclusions?.ownerId??null}) AND EXISTS(SELECT 1 FROM review_work w WHERE w.user_id=u.id AND w.completed_at IS NULL AND w.available_at<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM review_work_leases l WHERE l.user_id=u.id AND l.lease_until>clock_timestamp()) ORDER BY u.id FOR UPDATE OF u SKIP LOCKED LIMIT 1`;
   if(!owner)return null;
   // Recheck in a new statement snapshot after taking the owner lock. A competing claim may
   // have committed between the selection snapshot and acquisition of this lock.
   if((await tx`SELECT 1 FROM review_work_leases WHERE user_id=${owner.id} AND lease_until>clock_timestamp()`).length)return null;
   const [work]=await tx`SELECT w.*,d.result FROM review_work w JOIN review_decisions d USING(user_id,decision_id) WHERE w.user_id=${owner.id} AND w.completed_at IS NULL AND w.available_at<=clock_timestamp() ORDER BY w.created_at,w.command_id LIMIT 1`;
   if(!work)return null;await assertPilotDecision(tx,this.db.reviewExclusions,owner.id,work.decision_id);const leaseId=crypto.randomUUID();
   await tx`INSERT INTO review_work_leases(user_id,command_id,lease_id,lease_until,worker_id) VALUES(${owner.id},${work.command_id},${leaseId},clock_timestamp()+${leaseMs}*interval '1 millisecond',${workerId}) ON CONFLICT(user_id) DO UPDATE SET command_id=excluded.command_id,lease_id=excluded.lease_id,lease_until=excluded.lease_until,worker_id=excluded.worker_id`;
   const mutation=snapshot((await tx`SELECT * FROM spotify_mutations WHERE user_id=${owner.id} AND decision_id=${work.decision_id}`)[0]);
   return {userId:owner.id,decisionId:work.decision_id,operation:work.operation,commandId:work.command_id,leaseId,result:work.result,mutation};
  });
 }
 async renewReviewWork(userId:string,leaseId:string,leaseMs:number):Promise<boolean>{duration(leaseMs);return this.db.transaction(async tx=>{
  if(!await active(tx,userId,leaseId))return false;
  return (await tx`UPDATE review_work_leases SET lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond' WHERE user_id=${userId} AND lease_id=${leaseId} AND lease_until>clock_timestamp() RETURNING user_id`).length>0;
 });}
 async retryReviewWork(userId:string,leaseId:string,retryAt:number):Promise<boolean>{validTime(retryAt);return this.db.transaction(async tx=>{
  const row=await active(tx,userId,leaseId);if(!row)return false;
  await tx`UPDATE review_work SET available_at=${new Date(retryAt).toISOString()} WHERE user_id=${userId} AND command_id=${row.command_id}`;
  await tx`DELETE FROM review_work_leases WHERE user_id=${userId} AND lease_id=${leaseId}`;return true;
 });}
 async completeReviewWork(userId:string,leaseId:string):Promise<boolean>{return this.db.transaction(async tx=>{
  const row=await active(tx,userId,leaseId);if(!row)return false;
  const [done]=row.operation==='undo'
   ?await tx`SELECT 1 FROM undo_commands WHERE user_id=${userId} AND command_id=${row.command_id} AND settled_at IS NOT NULL`
   :await tx`SELECT 1 FROM review_decisions WHERE user_id=${userId} AND decision_id=${row.decision_id} AND result->>'status' IN ('COMPLETE','FAILED_TERMINAL','UNDONE')`;
  if(!done)return false;
  await tx`UPDATE review_work SET completed_at=clock_timestamp() WHERE user_id=${userId} AND command_id=${row.command_id}`;
  await tx`DELETE FROM review_work_leases WHERE user_id=${userId} AND lease_id=${leaseId}`;return true;
 });}
 async getMutation(userId:string,decisionId:string):Promise<MutationSnapshot|null>{return this.db.transaction(async tx=>snapshot((await tx`SELECT * FROM spotify_mutations WHERE user_id=${userId} AND decision_id=${decisionId}`)[0]));}
 async getPendingUndo(userId:string,decisionId:string):Promise<UndoCommandInput|null>{return this.db.transaction(async tx=>(await tx`SELECT payload FROM undo_commands WHERE user_id=${userId} AND decision_id=${decisionId} AND settled_at IS NULL`)[0]?.payload??null);}
 async getDecisionByIdempotencyKey(userId:string,key:string):Promise<ReviewResult|null>{return this.db.transaction(async tx=>{this.db.reviewExclusions?.assertOwner(userId);const [d]=await tx`SELECT decision_id,result FROM review_decisions WHERE user_id=${userId} AND idempotency_key=${key}`;if(d)await assertPilotDecision(tx,this.db.reviewExclusions,userId,d.decision_id);return d?.result??null;});}
 async getUndoByIdempotencyKey(userId:string,key:string):Promise<UndoCommandInput|null>{return this.db.transaction(async tx=>{this.db.reviewExclusions?.assertOwner(userId);const [u]=await tx`SELECT decision_id,payload FROM undo_commands WHERE user_id=${userId} AND idempotency_key=${key}`;if(u)await assertPilotDecision(tx,this.db.reviewExclusions,userId,u.decision_id);return u?.payload??null;});}
 async getReviewEffect(lease:ReviewLeaseIdentity,kind:ReviewEffectRequest['kind']):Promise<ReviewEffect|null>{return this.db.transaction(async tx=>{
  const work=await assertReviewLease(tx,lease.userId,null,lease);const key=effectKey(work,kind);
  const [row]=await tx`SELECT * FROM review_effects WHERE user_id=${lease.userId} AND effect_key=${key}`;return row?effect(row):null;
 });}
 async beginReviewEffect(lease:ReviewLeaseIdentity,request:ReviewEffectRequest):Promise<{effect:ReviewEffect;shouldExecute:boolean}>{return this.db.transaction(async tx=>{
  const work=await assertReviewLease(tx,lease.userId,null,lease);const key=effectKey(work,request.kind);
  const [decision]=await tx`SELECT d.track_id,d.result,c.decision_id AS current_id FROM review_decisions d LEFT JOIN current_decisions c USING(user_id,track_id) WHERE d.user_id=${lease.userId} AND d.decision_id=${work.decision_id}`;
  if(work.operation!=='review'||decision.current_id!==work.decision_id||decision.result.action!=='ARCHIVE')fail('REVIEW_EFFECT_CONFLICT');
  let canonical:ReviewEffectRequest;
  if(request.kind==='create_archive'){
   if(typeof request.name!=='string'||!request.name||typeof request.description!=='string'||!request.description||request.public!==false)fail('INVALID_REVIEW_EFFECT');
   canonical={kind:request.kind,name:request.name,public:false,description:request.description};
  }else{
   if(request.trackId!==decision.track_id||typeof request.playlistId!=='string'||!request.playlistId)fail('REVIEW_EFFECT_CONFLICT');
   const [playlist]=await tx`SELECT spotify_playlist_id FROM archive_playlists WHERE user_id=${lease.userId}`;
   if(playlist?.spotify_playlist_id!==request.playlistId)fail('REVIEW_EFFECT_CONFLICT');
   canonical={kind:request.kind,playlistId:request.playlistId,trackId:request.trackId};
  }
  const [old]=await tx`SELECT *,request=${json(canonical)}::jsonb AS same FROM review_effects WHERE user_id=${lease.userId} AND effect_key=${key}`;
  if(old&&!old.same)fail('REVIEW_EFFECT_CONFLICT');
  if(old&&old.state!=='retryable')return {effect:effect(old),shouldExecute:false};
  const [row]=await tx`INSERT INTO review_effects(user_id,effect_key,kind,request,state) VALUES(${lease.userId},${key},${request.kind},${json(canonical)}::jsonb,'intent') ON CONFLICT(user_id,effect_key) DO UPDATE SET state='intent',remote_id=NULL,updated_at=clock_timestamp() RETURNING *`;
  return {effect:effect(row),shouldExecute:true};
 });}
 async settleReviewEffect(lease:ReviewLeaseIdentity,kind:ReviewEffectRequest['kind'],state:'confirmed'|'retryable',remoteId:string|null):Promise<void>{await this.db.transaction(async tx=>{
  const work=await assertReviewLease(tx,lease.userId,null,lease);const key=effectKey(work,kind);
  if(work.operation!=='review'||!['confirmed','retryable'].includes(state)||(state==='confirmed'&&(!remoteId||typeof remoteId!=='string'))||(state==='retryable'&&remoteId!==null))fail('INVALID_REVIEW_EFFECT');
  const [old]=await tx`SELECT * FROM review_effects WHERE user_id=${lease.userId} AND effect_key=${key}`;if(!old)fail('REVIEW_EFFECT_NOT_FOUND');
  if(old.state==='confirmed'){if(state!==old.state||remoteId!==old.remote_id)fail('REVIEW_EFFECT_CONFLICT');return;}
  if(kind==='add_archive'&&state==='confirmed'&&remoteId!==old.request.playlistId)fail('REVIEW_EFFECT_CONFLICT');
  if(kind==='create_archive'&&state==='confirmed'){
   const [existing]=await tx`SELECT spotify_playlist_id FROM archive_playlists WHERE user_id=${lease.userId}`;if(existing&&existing.spotify_playlist_id!==remoteId)fail('REVIEW_EFFECT_CONFLICT');
   await tx`INSERT INTO archive_playlists(user_id,spotify_playlist_id) VALUES(${lease.userId},${remoteId!}) ON CONFLICT DO NOTHING`;
  }
  await tx`UPDATE review_effects SET state=${state},remote_id=${remoteId},updated_at=clock_timestamp() WHERE user_id=${lease.userId} AND effect_key=${key}`;
 });}
}
