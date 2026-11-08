import {afterAll,beforeAll,describe,expect,test} from 'bun:test';
import type {PolicyDeliveryAck} from '@sortfm/contracts';
import {Database,type Transaction} from '../src/client';
import {migrate} from '../src/migrate';
import {PostgresPolicyStore} from '../src/policy-store';
import {policyFixture} from './policy-fixtures';

const url=process.env.TEST_DATABASE_URL;
// Only this test connection resolves clock_timestamp() to the schema-local
// function. All queries, row locks, lease fences, writes and rollbacks use PG.
class ClockDatabase extends Database {
 at='';
 override transaction<T>(work:(tx:Transaction)=>Promise<T>,serializable=false):Promise<T>{
  return super.transaction(async tx=>{
   await tx.unsafe(`SET LOCAL search_path TO "${this.schema}", pg_catalog, public`);
   await tx`SELECT set_config('sortfm.test_clock',${this.at},true)`;
   return work(tx);
  },serializable);
 }
}

describe.skipIf(!url)('PostgreSQL release absence clock fence',()=>{
 let db:Database,clock:ClockDatabase,store:PostgresPolicyStore;
 beforeAll(async()=>{
  const schema=`test_release_clock_${crypto.randomUUID().replaceAll('-','')}`;
  db=new Database(url!,schema);await migrate(db);
  await db.transaction(tx=>tx.unsafe("CREATE FUNCTION clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$ SELECT current_setting('sortfm.test_clock')::timestamptz $$"));
  clock=new ClockDatabase(url!,schema);store=new PostgresPolicyStore(clock);
 },60000);
 afterAll(async()=>{await clock?.close();if(db){await db.sql.unsafe(`DROP SCHEMA "${db.schema}" CASCADE`);await db.close();}},60000);

 async function fixture(published=false){
  const f=await policyFixture(db),normal=new PostgresPolicyStore(db),input=f.adaptive();
  const prepared=await normal.prepareSelection(input),response=f.response(input);
  if(published)await normal.publishSelection({userId:f.userId,requestId:input.requestId,leaseId:prepared.intent.lease!.leaseId,...response});
  await normal.releaseSelection({userId:f.userId,requestId:input.requestId,releaseId:crypto.randomUUID(),exposureIds:[response.decision.exposureId],reason:'abandoned',...(!published?{expectedLeaseId:prepared.intent.lease!.leaseId}:{})});
  const grace=Date.now(),iso=(offset:number)=>new Date(grace+offset).toISOString();
  await db.transaction(async tx=>{
   await tx`UPDATE policy_selection_intents SET created_at=${iso(-300000)},expires_at=${iso(-60000)} WHERE user_id=${f.userId}`;
   await tx`UPDATE policy_delivery_events SET available_at=${iso(-10000)} WHERE user_id=${f.userId}`;
  });
  const claim=async(offset=0)=>{clock.at=iso(offset);const lease=await store.claimPolicyDelivery({workerId:'clock-test',leaseMs:60000});expect(lease?.event.userId).toBe(f.userId);return lease!;};
  const ack=(lease:Awaited<ReturnType<typeof claim>>,offset:number):PolicyDeliveryAck=>({userId:f.userId,eventId:lease.event.eventId,leaseId:lease.leaseId,kind:'release_absent',exposureId:response.decision.exposureId,checkedAt:iso(offset),providerStatus:404});
  const event=()=>db.transaction(async tx=>(await tx`SELECT * FROM policy_delivery_events WHERE user_id=${f.userId}`)[0]);
  // Retain fixture rows for FK integrity; remove only delivery work between cases.
  const cleanup=()=>db.transaction(tx=>tx`DELETE FROM policy_delivery_events WHERE user_id=${f.userId}`);
  return {...f,input,prepared,response,normal,iso,claim,ack,event,cleanup};
 }

 for(const offset of [-500,-150,0,150,500])test(`accepts ${offset}ms skew at exact DB grace and retains actual checkedAt`,async()=>{
  const f=await fixture();try{
   const lease=await f.claim(),ack=f.ack(lease,offset);
   expect(await store.acknowledgePolicyDelivery(ack)).toBe(true);
   const event=await f.event();expect(event.disposition).toBe('absent_after_deadline');expect(event.receipt).toEqual(ack);expect(event.completed_at.toISOString()).toBe(f.iso(0));expect(event.lease_id).toBeNull();
   expect((await f.normal.publishSelection({userId:f.userId,requestId:f.input.requestId,leaseId:f.prepared.intent.lease!.leaseId,...f.response})).outcome).toBe('rejected');
   expect(await db.transaction(tx=>tx`SELECT 1 FROM exposures WHERE user_id=${f.userId}`)).toHaveLength(0);
  }finally{await f.cleanup();}
 });
 for(const offset of [-501,501,-60000,60000])test(`rejects ${offset}ms skew without consuming the lease`,async()=>{
  const f=await fixture();try{
   const lease=await f.claim();await expect(store.acknowledgePolicyDelivery(f.ack(lease,offset))).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
   const event=await f.event();expect(event.completed_at).toBeNull();expect(event.receipt).toBeNull();expect(event.lease_id).toBe(lease.leaseId);
  }finally{await f.cleanup();}
 });
 test('pre-grace lease cannot settle after grace; a new post-grace claim can',async()=>{
  const f=await fixture();try{
   const early=await f.claim(-1);clock.at=f.iso(150);
   await expect(store.acknowledgePolicyDelivery(f.ack(early,150))).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
   expect(await store.retryPolicyDelivery({userId:f.userId,eventId:early.event.eventId,leaseId:early.leaseId,retryAt:f.iso(150),errorCode:'POLICY_DELIVERY_RETRY'})).toBe(true);
   const fresh=await f.claim(1000);expect(fresh.leaseId).not.toBe(early.leaseId);expect(fresh.event.eventId).toBe(early.event.eventId);
   expect(await store.acknowledgePolicyDelivery(f.ack(early,1000))).toBe(false);
   expect(await store.acknowledgePolicyDelivery(f.ack(fresh,850))).toBe(true);
  }finally{await f.cleanup();}
 });
 for(const [start,ackAt] of [[0,-1],[100,99]] as const)test(`DB rollback from lease ${start}ms to ack ${ackAt}ms fails closed`,async()=>{
  const f=await fixture();try{
   const lease=await f.claim(start);clock.at=f.iso(ackAt);
   await expect(store.acknowledgePolicyDelivery(f.ack(lease,start))).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
   expect((await f.event()).completed_at).toBeNull();
  }finally{await f.cleanup();}
 });
 test('wrong owner, event, exposure, stale token and expired lease cannot settle',async()=>{
  const f=await fixture(),other=await policyFixture(db);try{
   const lease=await f.claim(),ack=f.ack(lease,0);
   expect(await store.acknowledgePolicyDelivery({...ack,userId:other.userId})).toBe(false);
   expect(await store.acknowledgePolicyDelivery({...ack,eventId:crypto.randomUUID()})).toBe(false);
   expect(await store.acknowledgePolicyDelivery({...ack,leaseId:crypto.randomUUID()})).toBe(false);
   await expect(store.acknowledgePolicyDelivery({...ack,exposureId:crypto.randomUUID()} as PolicyDeliveryAck)).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
   clock.at=f.iso(60000);expect(await store.acknowledgePolicyDelivery(f.ack(lease,60000))).toBe(false);expect((await f.event()).completed_at).toBeNull();
  }finally{await f.cleanup();}
 });
 test('publication and binding each independently prohibit absence acknowledgment',async()=>{
  const f=await fixture(true);try{
   const lease=await f.claim(),ack=f.ack(lease,0);
   await db.transaction(tx=>tx`UPDATE policy_exposure_bindings SET published=false WHERE user_id=${f.userId}`);
   await expect(store.acknowledgePolicyDelivery(ack)).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});
   await db.transaction(async tx=>{
    await tx`UPDATE policy_exposure_bindings SET published=true WHERE user_id=${f.userId}`;
    await tx`UPDATE policy_selection_intents SET publication=NULL WHERE user_id=${f.userId}`;
   });
   await expect(store.acknowledgePolicyDelivery(ack)).rejects.toMatchObject({code:'POLICY_RECEIPT_MISMATCH'});expect((await f.event()).completed_at).toBeNull();
  }finally{await f.cleanup();}
 });
});
