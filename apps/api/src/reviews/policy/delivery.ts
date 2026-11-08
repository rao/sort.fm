import {z} from 'zod';
import {
 IdSchema,UuidSchema,TimestampSchema,PolicyAssociationRequestSchema,PolicyAssociationReceiptSchema,
 PolicyReleaseRequestSchema,PolicyReleaseReceiptSchema,PolicyExposureSchema,
 type PolicyStore,type PolicyDeliveryLease,type PolicyDeliveryAck,
} from '@sortfm/contracts';
import {MlClientError,type PolicyClient} from '../../ml/client';

export interface PolicyDeliveryOptions {
 now?:()=>number;
 /** Total delivery/inspection/acknowledgement wait, shorter than the DB lease. */
 timeoutMs?:number;
 leaseMs?:number;
 retryMs?:number;
 pollMs?:number;
 onError?:(code:'POLICY_DELIVERY_RETRY'|'POLICY_DELIVERY_LEASE_LOST'|'POLICY_DELIVERY_UNAVAILABLE'|'POLICY_DELIVERY_INVALID_LEASE')=>void;
}
type Store=Pick<PolicyStore,'claimPolicyDelivery'|'acknowledgePolicyDelivery'|'retryPolicyDelivery'>;
type Client=Pick<PolicyClient,'associate'|'release'|'exposure'>;
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Only these validated outer fields authorize addressing a durable retry/ack.
const envelopeSchema=z.object({
 event:z.object({userId:IdSchema,eventId:UuidSchema,sequence:count.min(1),createdAt:TimestampSchema,kind:z.enum(['associate','release'])}),
 leaseId:UuidSchema,leaseUntil:TimestampSchema,attempts:count,
});
const invalid=()=>new Error('POLICY_DELIVERY_INVALID_RESPONSE');
const absent=(error:unknown)=>error instanceof MlClientError&&error.status===404&&error.code==='POLICY_EXPOSURE_NOT_FOUND';

/** Independent ordered association/release delivery. Never fits or observes feedback. */
export class PolicyDeliveryWorker {
 private readonly workerId=crypto.randomUUID();
 private readonly now:()=>number;
 private readonly timeoutMs:number;
 private readonly leaseMs:number;
 private readonly retryMs:number;
 private readonly pollMs:number;
 private timer:ReturnType<typeof setInterval>|undefined;
 private running:Promise<void>|undefined;
 private stopped=false;
 constructor(private readonly store:Store,private readonly client:Client,private readonly options:PolicyDeliveryOptions={}) {
  this.now=options.now??Date.now;this.timeoutMs=options.timeoutMs??45000;this.leaseMs=options.leaseMs??120000;
  this.retryMs=options.retryMs??30000;this.pollMs=options.pollMs??5000;
  for(const value of [this.timeoutMs,this.leaseMs,this.retryMs,this.pollMs])if(!Number.isInteger(value)||value<=0||value>2_147_483_647)throw new RangeError('Invalid policy delivery timer');
  if(this.leaseMs<1000||this.leaseMs>120000||this.leaseMs<=this.timeoutMs+1000)throw new RangeError('Policy delivery deadline must leave time to settle its lease');
 }
 private report(code:Parameters<NonNullable<PolicyDeliveryOptions['onError']>>[0]) {
  try{this.options.onError?.(code);}catch{/* Diagnostic callbacks cannot interrupt durable recovery. */}
 }
 private async bounded<T>(work:()=>Promise<T>,deadline:number):Promise<T> {
  const remaining=deadline-performance.now();if(remaining<=0)throw invalid();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const value=await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(invalid()),Math.ceil(remaining));})]);
   if(performance.now()>=deadline)throw invalid();return value;
  }finally{clearTimeout(timer);}
 }
 private async deliver(lease:PolicyDeliveryLease,deadline:number):Promise<PolicyDeliveryAck> {
  const event=lease.event,fence={userId:event.userId,eventId:event.eventId,leaseId:lease.leaseId};
  if(event.kind==='associate'){
   const request=PolicyAssociationRequestSchema.parse({userId:event.userId,event:event.event,fitReceipt:lease.fitReceipt});
   if(request.event.eventId!==event.eventId||request.event.sequence!==event.sequence)throw invalid();
   // A transport is injectable; never allow it to mutate our comparison/retry identity.
   const response=PolicyAssociationReceiptSchema.parse(await this.bounded(()=>this.client.associate(structuredClone(request)),deadline));
   if(response.userId!==event.userId||response.eventId!==event.eventId||response.sequence!==event.sequence
    ||response.fitReceipt.modelVersion!==request.fitReceipt.modelVersion
    ||response.fitReceipt.synchronizedFeedbackRevision!==request.fitReceipt.synchronizedFeedbackRevision
    ||(response.eligibleForLearning&&(request.event.operation==='revoke'||request.event.label===null||!request.event.features.permittedForTraining)))throw invalid();
   return {...fence,kind:'associate',receipt:response};
  }
  const request=PolicyReleaseRequestSchema.parse(event.request);
  if(request.userId!==event.userId||lease.fitReceipt!==null)throw invalid();
  let value:unknown;
  try{value=await this.bounded(()=>this.client.release(structuredClone(request)),deadline);}
  catch(error){
   if(!absent(error))throw error;
   // Release404 is not proof of absence: an in-flight select may still commit.
   // Only an independently observed exact inspection404 can be offered to D,
   // which checks unpublished state, original expiry+grace and this live lease.
   try{
    const inspection=PolicyExposureSchema.parse(await this.bounded(()=>this.client.exposure({userId:request.userId,exposureId:request.exposureId}),deadline));
    if(inspection.decision.userId!==request.userId||inspection.decision.exposureId!==request.exposureId||inspection.reservation.exposureId!==request.exposureId)throw invalid();
   }catch(inspectError){
    if(!absent(inspectError))throw inspectError;
    return {...fence,kind:'release_absent',exposureId:request.exposureId,checkedAt:new Date(this.now()).toISOString(),providerStatus:404};
   }
   // Even an inspected expired/closed lease is not a fabricated release receipt.
   throw invalid();
  }
  const response=PolicyReleaseReceiptSchema.parse(value);
  if(response.userId!==request.userId||response.requestId!==request.requestId||response.exposureId!==request.exposureId
   ||Date.parse(response.effectiveClosedAt)>Date.parse(response.expiresAt)
   ||(response.outcome==='released'&&Date.parse(response.effectiveClosedAt)>Date.parse(response.recordedAt)))throw invalid();
  return {...fence,kind:'release',receipt:response};
 }
 async runOnce():Promise<boolean> {
  const claimed=await this.bounded(()=>this.store.claimPolicyDelivery({workerId:this.workerId,leaseMs:this.leaseMs}),performance.now()+this.timeoutMs);
  if(!claimed)return false;
  const lease=structuredClone(claimed),parsed=envelopeSchema.safeParse(lease);
  if(!parsed.success||Date.parse(parsed.data.leaseUntil)<=this.now()){this.report('POLICY_DELIVERY_INVALID_LEASE');return true;}
  const {userId,eventId}=parsed.data.event,leaseId=parsed.data.leaseId;
  const deadline=performance.now()+Math.min(this.timeoutMs,Date.parse(parsed.data.leaseUntil)-this.now());
  try{
   const ack=await this.deliver(lease,deadline);
   if(!await this.bounded(()=>this.store.acknowledgePolicyDelivery(ack),deadline))this.report('POLICY_DELIVERY_LEASE_LOST');
  }catch{
   this.report('POLICY_DELIVERY_RETRY');
   // No raw provider exception, payload or upstream code enters the journal/log.
   const retried=await this.bounded(()=>this.store.retryPolicyDelivery({userId,eventId,leaseId,retryAt:new Date(this.now()+this.retryMs).toISOString(),errorCode:'POLICY_DELIVERY_RETRY'}),performance.now()+this.timeoutMs);
   if(!retried)this.report('POLICY_DELIVERY_LEASE_LOST');
  }
  return true;
 }
 kick() {
  if(this.running||this.stopped)return;
  this.running=(async()=>{for(let count=0;count<10&&!this.stopped;count++)if(!await this.runOnce())break;})()
   .catch(()=>this.report('POLICY_DELIVERY_UNAVAILABLE')).finally(()=>{this.running=undefined;});
 }
 start() {
  if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>this.kick(),this.pollMs);this.timer.unref();this.kick();
 }
 async close() {this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.running;}
}
