import {createHash} from 'node:crypto';import {z} from 'zod';
import {IdSchema,UuidSchema,TimestampSchema,ExposureInputSchema,PolicySelectRequestSchema,QueuePolicySchema,ListeningContextSnapshotSchema,type PolicyDeliveryEvent} from '@sortfm/contracts';
import {Database,PersistenceError,json,type Transaction} from './client';
export const fail=(code:string):never=>{throw new PersistenceError(code);};
export const iso=(value:Date|string)=>new Date(value).toISOString();
export const canonical=(value:unknown):string=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
export function parse<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{const r=schema.safeParse(value);if(!r.success)return fail('INVALID_POLICY_INPUT');return r.data;}
export const leaseMs=z.number().int().min(1000).max(120000),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ownerInput=z.strictObject({userId:IdSchema});
export const fence=z.strictObject({userId:IdSchema,requestId:UuidSchema,leaseId:UuidSchema});
export const claim=z.strictObject({workerId:z.string().min(1).max(128),leaseMs});
export const prepare=z.strictObject({userId:IdSchema,requestId:UuidSchema,feedbackRevision:count,membershipRevision:count,leaseMs,reservationMs:z.number().int().min(30000).max(900000),draft:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('c1'),items:z.array(ExposureInputSchema).min(1).max(100)}),
 z.strictObject({kind:z.literal('adaptive'),queuePolicy:QueuePolicySchema,request:PolicySelectRequestSchema,listeningContext:ListeningContextSnapshotSchema.optional()}),
])});
export const release=z.strictObject({userId:IdSchema,requestId:UuidSchema,releaseId:UuidSchema,expectedLeaseId:UuidSchema.optional(),exposureIds:z.array(UuidSchema).min(1).max(100),reason:z.enum(['skip','abandoned','prefetch_discarded'])});
export const retry=z.strictObject({userId:IdSchema,eventId:UuidSchema,leaseId:UuidSchema,retryAt:TimestampSchema,errorCode:z.enum(['POLICY_UNAVAILABLE','POLICY_TIMEOUT','POLICY_RATE_LIMITED','POLICY_RECEIPT_STALE','POLICY_EXPOSURE_NOT_FOUND','POLICY_DELIVERY_RETRY','POLICY_RESPONSE_INVALID'])});
export async function ready(tx:Transaction){
 const [r]=await tx`SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='016_policy.sql') AS installed,
 (SELECT count(*)::integer FROM unnest(ARRAY['policy_selection_intents','policy_exposure_bindings','policy_fit_receipts','policy_delivery_events','policy_release_commands','policy_owner_state']) AS expected(name) WHERE to_regclass(current_schema()||'.'||name) IS NOT NULL) AS tables`;
 // Only a completely absent optional installation is a genuine legacy schema.
 if((r.installed&&r.tables!==6)||(!r.installed&&r.tables!==0))fail('POLICY_STORAGE_CORRUPT');return Boolean(r.installed);
}
export async function owner(tx:Transaction,userId:string){const [row]=await tx`SELECT feedback_revision,membership_revision FROM users WHERE id=${userId} FOR UPDATE`;return row??fail('USER_NOT_FOUND');}
export async function now(tx:Transaction){return new Date((await tx`SELECT clock_timestamp() AS at`)[0].at).getTime();}
export async function atomic<T>(db:Database,work:(tx:Transaction)=>Promise<T>):Promise<T>{
 for(let retry=0;;retry++)try{return await db.transaction(async tx=>{await tx.unsafe("SET LOCAL lock_timeout='3s'");await tx.unsafe("SET LOCAL statement_timeout='10s'");return work(tx);});}catch(e){const error=e as any;if(retry>=3||![error.code,error.errno,error.sqlState].some(c=>c==='40001'||c==='40P01'))throw e;await Bun.sleep(25*2**retry+Math.random()*25);}
}
export async function requireReady(tx:Transaction){if(!await ready(tx))fail('POLICY_STORAGE_UNAVAILABLE');}
export async function intent(tx:Transaction,userId:string,requestId:string){const [row]=await tx`SELECT * FROM policy_selection_intents WHERE user_id=${userId} AND request_id=${requestId}`;return row??fail('POLICY_SELECTION_NOT_FOUND');}
export async function fitReceipt(tx:Transaction,userId:string){const [row]=await tx`SELECT model_version,feedback_revision FROM policy_fit_receipts WHERE user_id=${userId}`;return row?{modelVersion:row.model_version as string,synchronizedFeedbackRevision:Number(row.feedback_revision)}:null;}
/** Owner lock is held by all callers; increment and event creation share their transaction. */
export async function enqueue(tx:Transaction,row:any,exposureId:string,dedupeKey:string,kind:'associate'|'release',payload:(eventId:string,sequence:number)=>unknown){
 if((await tx`SELECT 1 FROM policy_delivery_events WHERE user_id=${row.user_id} AND dedupe_key=${dedupeKey}`).length)return;
 const [s]=await tx`INSERT INTO policy_owner_state(user_id,sequence) VALUES(${row.user_id},1) ON CONFLICT(user_id) DO UPDATE SET sequence=policy_owner_state.sequence+1 RETURNING sequence`;
 const id=crypto.randomUUID(),sequence=Number(s.sequence);
 await tx`INSERT INTO policy_delivery_events(event_id,user_id,sequence,dedupe_key,kind,payload,request_id,exposure_id) VALUES(${id},${row.user_id},${sequence},${dedupeKey},${kind},${json(payload(id,sequence))}::jsonb,${row.request_id},${exposureId})`;
}
export async function enqueueRelease(tx:Transaction,row:any,exposureId:string,reason:'skip'|'abandoned'|'prefetch_discarded'){
 if(row.draft.kind!=='adaptive')return;
 await enqueue(tx,row,exposureId,`release:${exposureId}`,'release',()=>({userId:row.user_id,requestId:crypto.randomUUID(),exposureId,reason}));
}
export function delivery(row:any):PolicyDeliveryEvent{return {userId:row.user_id,eventId:row.event_id,sequence:Number(row.sequence),createdAt:iso(row.created_at),...(row.kind==='associate'?{kind:'associate' as const,event:row.payload}:{kind:'release' as const,request:row.payload})};}
