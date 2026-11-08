import type {PolicyStore} from '@sortfm/contracts';
import type {PolicyClient} from '../../ml/client';
import {abandonSelection,bounded,publishAdaptive} from './selection';

export interface PolicyRecoveryOptions {
  now?:()=>number;timeoutMs?:number;leaseMs?:number;pollMs?:number;onError?:(code:string)=>void;
}
type RecoveryStore=Pick<PolicyStore,'claimSelectionRecovery'|'publishSelection'|'releaseSelection'>;
/** Recovers exact durable requests; later GETs can reuse D's servable publication. */
export class PolicySelectionRecoveryWorker {
  private readonly workerId=crypto.randomUUID();
  private readonly now:()=>number;
  private readonly timeout:number;
  private readonly leaseMs:number;
  private timer:ReturnType<typeof setInterval>|undefined;
  private running:Promise<void>|undefined;
  private stopped=false;
  constructor(private readonly store:RecoveryStore,private readonly client:Pick<PolicyClient,'select'|'exposure'>,private readonly options:PolicyRecoveryOptions={}) {
    this.now=options.now??Date.now;this.timeout=options.timeoutMs??15000;this.leaseMs=options.leaseMs??60000;
    if(!Number.isInteger(this.timeout)||this.timeout<=0||!Number.isInteger(this.leaseMs)||this.leaseMs>120000
      ||this.leaseMs<this.timeout+1000||!Number.isInteger(options.pollMs??5000)||(options.pollMs??5000)<1)throw new Error('Invalid policy recovery deadlines');
  }
  private report(code:string):void {try{this.options.onError?.(code);}catch{/* Diagnostics cannot block recovery. */}}
  async runOnce():Promise<boolean> {
    const intent=await bounded(()=>this.store.claimSelectionRecovery({workerId:this.workerId,leaseMs:this.leaseMs}),this.timeout);
    if(!intent)return false;
    if(!intent.lease||intent.status!=='prepared') {this.report('POLICY_RECOVERY_INVALID_LEASE');return true;}
    try {
      if(Date.parse(intent.expiresAt)<=this.now()||Date.parse(intent.lease.leaseUntil)<=this.now())throw new Error('POLICY_RECOVERY_EXPIRED');
      if(intent.draft.kind==='adaptive')await publishAdaptive(this.store,this.client,intent,this.now,this.timeout);
      else await bounded(()=>this.store.publishSelection({userId:intent.userId,requestId:intent.requestId,leaseId:intent.lease!.leaseId,kind:'c1'}),this.timeout);
    } catch {
      this.report('POLICY_RECOVERY_RELEASE');
      await bounded(()=>abandonSelection(this.store,intent),this.timeout);
    }
    return true;
  }
  kick():void {
    if(this.running||this.stopped)return;
    this.running=(async()=>{for(let count=0;count<10&&!this.stopped;count++)if(!await this.runOnce())break;})()
      .catch(()=>{this.report('POLICY_RECOVERY_UNAVAILABLE');}).finally(()=>{this.running=undefined;});
  }
  start():void {
    if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>this.kick(),this.options.pollMs??5000);this.timer.unref();this.kick();
  }
  async close():Promise<void> {this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.running;}
}
