import {z} from 'zod';
import {IdSchema,UuidSchema,PlaybackReturnToSchema,PlaybackSdkScopesSchema,PlaybackControlScopesSchema,type PlaybackStore,type PlaybackGrant,type PlaybackGrantPurpose,type PlaybackOAuthAttempt,type PlaybackSessionContext,type PlaybackRefreshFence} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';

const fail=(code:string):never=>{throw new PersistenceError(code);};
const time=z.number().int().min(0).max(8_640_000_000_000_000),hash=z.string().regex(/^[a-f0-9]{64}$/),purpose=z.enum(['sdk','control']);
const sessionFields={ownerId:IdSchema,initiatingSessionHash:hash,now:time};
const context=z.strictObject(sessionFields),key={ownerId:IdSchema,purpose};
const fence=context.extend({purpose,expectedCredentialVersion:UuidSchema,leaseId:UuidSchema});
const lease=z.strictObject({id:UuidSchema,until:time,initiatingSessionHash:hash});
const attemptShape=z.strictObject({ownerId:IdSchema,purpose,initiatingSessionHash:hash,stateHash:hash,browserHash:hash,encryptedVerifier:z.string(),returnTo:PlaybackReturnToSchema,createdAt:time,expiresAt:time,expectedCredentialVersion:UuidSchema.nullable()});
const grantShape=z.strictObject({...key,encryptedAccessToken:z.string(),encryptedRefreshToken:z.string(),expiresAt:time,credentialVersion:UuidSchema,revoked:z.boolean(),refreshLease:lease.nullable(),scopes:z.array(z.string()).max(32)});
function read<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const parsed=schema.safeParse(value);if(!parsed.success)return fail('INVALID_PLAYBACK_INPUT');return parsed.data;}
function encrypted(value:string){if(value.length>65536||!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/.test(value))fail('ENCRYPTED_CREDENTIAL_REQUIRED');}
function grant(value:unknown,publishing=false):PlaybackGrant{
 const g=read(grantShape,value);
 const scopes=(g.purpose==='sdk'?PlaybackSdkScopesSchema:PlaybackControlScopesSchema).safeParse(g.scopes);if(!scopes.success)fail('PLAYBACK_SCOPE_REJECTED');
 if(publishing&&(g.revoked||g.refreshLease!==null))fail('INVALID_PLAYBACK_INPUT');
 if(g.revoked){if(g.encryptedAccessToken!==''||g.encryptedRefreshToken!=='')fail('INVALID_PLAYBACK_INPUT');}
 else{encrypted(g.encryptedAccessToken);encrypted(g.encryptedRefreshToken);}
 if(g.expiresAt===0)fail('INVALID_PLAYBACK_INPUT');
 return {...g,scopes:scopes.data} as PlaybackGrant;
}
function attempt(value:unknown):PlaybackOAuthAttempt{const a=read(attemptShape,value);encrypted(a.encryptedVerifier);if(a.expiresAt<=a.createdAt)fail('INVALID_PLAYBACK_INPUT');return a;}
function logicalClock(now:number){const started=performance.now();return ()=>{const value=now+Math.floor(performance.now()-started);if(value>8_640_000_000_000_000)fail('INVALID_PLAYBACK_INPUT');return value;};}
async function owner(tx:Transaction,ownerId:string){return (await tx`SELECT id,is_authorized FROM users WHERE id=${ownerId} FOR UPDATE`)[0];}
async function loadGrant(tx:Transaction,ownerId:string,kind:PlaybackGrantPurpose):Promise<PlaybackGrant|null>{const [row]=await tx`SELECT payload FROM playback_grants WHERE user_id=${ownerId} AND purpose=${kind} FOR UPDATE`;if(!row)return null;const g=grant(row.payload);if(g.ownerId!==ownerId||g.purpose!==kind)fail('INVALID_PLAYBACK_INPUT');return g;}
async function saveGrant(tx:Transaction,g:PlaybackGrant){await tx`INSERT INTO playback_grants(user_id,purpose,payload) VALUES(${g.ownerId},${g.purpose},${json(g)}::jsonb) ON CONFLICT(user_id,purpose) DO UPDATE SET payload=excluded.payload,updated_at=clock_timestamp()`;}
function storedAttempt(row:any):PlaybackOAuthAttempt{
 try{const a=attempt(row.payload);if(a.stateHash!==row.state_hash||a.ownerId!==row.user_id||a.purpose!==row.purpose||a.expiresAt!==new Date(row.expires_at).getTime())fail('OAUTH_STATE_INVALID');return a;}catch{return fail('OAUTH_STATE_INVALID');}
}
function matchesLease(g:PlaybackGrant|null,input:PlaybackRefreshFence):g is PlaybackGrant{
 return Boolean(g&&!g.revoked&&g.credentialVersion===input.expectedCredentialVersion&&g.refreshLease?.id===input.leaseId&&g.refreshLease.initiatingSessionHash===input.initiatingSessionHash);
}
/** A1 owns cryptography and provider I/O; this adapter only accepts sealed envelopes. */
export class PostgresPlaybackStore implements PlaybackStore {
 constructor(readonly db:Database){}
 private async atomic<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
  for(let attempt=0;;attempt++)try{return await this.db.transaction(async tx=>{
   await tx.unsafe("SET LOCAL lock_timeout='2s'");await tx.unsafe("SET LOCAL statement_timeout='5s'");return work(tx);
  },true);}catch(error){const e=error as {errno?:string;code?:string;sqlState?:string};if(attempt>=3||![e.errno,e.code,e.sqlState].some(v=>v==='40001'||v==='40P01'))throw error;await Bun.sleep(25*2**attempt+Math.random()*25);}
 }
 private async session<T>(input:PlaybackSessionContext,work:(tx:Transaction,now:()=>number)=>Promise<T>):Promise<T>{
  const clock=logicalClock(input.now);
  return this.atomic(async tx=>{
   const user=await owner(tx,input.ownerId);if(!user?.is_authorized)fail('AUTHENTICATION_REQUIRED');
   const [s]=await tx`SELECT user_id,expires_at FROM auth_sessions WHERE hash=${input.initiatingSessionHash} FOR UPDATE`;
   if(!s||s.user_id!==input.ownerId)fail('AUTHENTICATION_REQUIRED');
   const [row]=await tx`SELECT encrypted_payload FROM oauth_credentials WHERE user_id=${input.ownerId} FOR UPDATE`;
   let account:any;try{account=row?JSON.parse(row.encrypted_payload):null;}catch{fail('AUTHENTICATION_REQUIRED');}
   if(!account||account.revoked!==false||account.user?.id!==input.ownerId||!account.user.spotifyId||input.ownerId!==`spotify:${account.user.spotifyId}`)fail('AUTHENTICATION_REQUIRED');
   const now=()=>{const value=clock();if(new Date(s.expires_at).getTime()<=value)fail('AUTHENTICATION_REQUIRED');return value;};
   now();const result=await work(tx,now);now();return result;
  });
 }
 async createOAuth(value:PlaybackOAuthAttempt,at:number):Promise<void>{
  const a=attempt(value),now=read(time,at);
  await this.session({ownerId:a.ownerId,initiatingSessionHash:a.initiatingSessionHash,now},async(tx,clock)=>{
   const current=await loadGrant(tx,a.ownerId,a.purpose);if((current?.credentialVersion??null)!==a.expectedCredentialVersion)fail('STATE_CONFLICT');
   if((await tx`SELECT 1 FROM oauth_attempts WHERE state_hash=${a.stateHash}`).length)fail('STATE_CONFLICT');
   const checked=clock();if(a.createdAt>checked)fail('INVALID_PLAYBACK_INPUT');if(a.expiresAt<=checked)fail('OAUTH_STATE_INVALID');
   const rows=await tx`INSERT INTO playback_oauth_attempts(state_hash,user_id,purpose,payload,expires_at) VALUES(${a.stateHash},${a.ownerId},${a.purpose},${json(a)}::jsonb,${new Date(a.expiresAt).toISOString()}) ON CONFLICT DO NOTHING RETURNING state_hash`;if(!rows.length)fail('STATE_CONFLICT');
  });
 }
 async consumeOAuth(value:Parameters<PlaybackStore['consumeOAuth']>[0]):Promise<PlaybackOAuthAttempt>{
  const v=read(context.extend({stateHash:hash,purpose,browserHash:hash}),value);
  return this.session(v,async(tx,clock)=>{
   const [row]=await tx`SELECT * FROM playback_oauth_attempts WHERE state_hash=${v.stateHash} AND user_id=${v.ownerId} FOR UPDATE`;
   if(!row||row.consumed_at!==null||row.completed_at!==null)fail('OAUTH_STATE_INVALID');const a=storedAttempt(row);
   if(a.purpose!==v.purpose||a.initiatingSessionHash!==v.initiatingSessionHash||a.browserHash!==v.browserHash||a.expiresAt<=clock())fail('OAUTH_STATE_INVALID');
   await tx`UPDATE playback_oauth_attempts SET consumed_at=${new Date(clock()).toISOString()} WHERE state_hash=${a.stateHash}`;return a;
  });
 }
 async completeOAuth(value:Parameters<PlaybackStore['completeOAuth']>[0]):Promise<boolean>{
  const v=read(context.extend({stateHash:hash,grant:z.unknown()}),value),g=grant(v.grant,true);
  return this.session(v,async(tx,clock)=>{
   const [row]=await tx`SELECT * FROM playback_oauth_attempts WHERE state_hash=${v.stateHash} AND user_id=${v.ownerId} FOR UPDATE`;
   if(!row||row.consumed_at===null||row.completed_at!==null)return false;const a=storedAttempt(row);
   if(a.initiatingSessionHash!==v.initiatingSessionHash||g.ownerId!==v.ownerId||g.purpose!==a.purpose)return false;
   const current=await loadGrant(tx,v.ownerId,a.purpose),checked=clock();
   if(a.expiresAt<=checked||g.expiresAt<=checked||(current?.credentialVersion??null)!==a.expectedCredentialVersion||g.credentialVersion===current?.credentialVersion)return false;
   await saveGrant(tx,g);await tx`UPDATE playback_oauth_attempts SET completed_at=${new Date(clock()).toISOString()} WHERE state_hash=${a.stateHash}`;return true;
  });
 }
 async getGrant(value:Parameters<PlaybackStore['getGrant']>[0]):Promise<PlaybackGrant|null>{const v=read(context.extend({purpose}),value);return this.session(v,tx=>loadGrant(tx,v.ownerId,v.purpose));}
 async claimRefresh(value:Parameters<PlaybackStore['claimRefresh']>[0]):Promise<PlaybackGrant|null>{
  const v=read(fence.extend({leaseUntil:time}),value);
  return this.session(v,async(tx,clock)=>{const current=await loadGrant(tx,v.ownerId,v.purpose),checked=clock();if(v.leaseUntil<=checked)fail('INVALID_PLAYBACK_INPUT');
   if(!current||current.revoked||current.credentialVersion!==v.expectedCredentialVersion||(current.refreshLease&&current.refreshLease.until>checked))return null;
   const next={...current,refreshLease:{id:v.leaseId,until:v.leaseUntil,initiatingSessionHash:v.initiatingSessionHash}};await saveGrant(tx,next);return next;
  });
 }
 async completeRefresh(value:Parameters<PlaybackStore['completeRefresh']>[0]):Promise<boolean>{
  const v=read(fence.extend({grant:z.unknown()}),value),g=grant(v.grant,true);
  return this.session(v,async(tx,clock)=>{const current=await loadGrant(tx,v.ownerId,v.purpose),checked=clock();
   if(!matchesLease(current,v)||current.refreshLease!.until<=checked||g.ownerId!==v.ownerId||g.purpose!==v.purpose||g.credentialVersion===v.expectedCredentialVersion||g.expiresAt<=checked)return false;
   await saveGrant(tx,g);return true;
  });
 }
 async releaseRefresh(value:PlaybackRefreshFence):Promise<boolean>{const v=read(fence,value);return this.session(v,async tx=>{const current=await loadGrant(tx,v.ownerId,v.purpose);if(!matchesLease(current,v))return false;await saveGrant(tx,{...current,refreshLease:null});return true;});}
 async revokeGrant(value:Parameters<PlaybackStore['revokeGrant']>[0]):Promise<boolean>{
  const v=read(z.object({...key,expectedCredentialVersion:UuidSchema,leaseId:UuidSchema.optional(),now:time}),value);
  return this.atomic(async tx=>{if(!await owner(tx,v.ownerId))return false;const current=await loadGrant(tx,v.ownerId,v.purpose);
   if(!current||current.revoked||current.credentialVersion!==v.expectedCredentialVersion||(v.leaseId!==undefined&&current.refreshLease?.id!==v.leaseId))return false;
   await saveGrant(tx,{...current,encryptedAccessToken:'',encryptedRefreshToken:'',revoked:true,refreshLease:null});return true;
  });
 }
}
