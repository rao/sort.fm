import {FitResponseSchema, type FitResponse} from '@sortfm/contracts';

export interface FeedbackRepository {
  claimFeedbackSync(workerId:string,now:number,leaseMs:number):Promise<{userId:string;feedbackRevision:number;leaseId:string}|null>;
  acknowledgeFeedbackSync(userId:string,leaseId:string,revision:number,receipt?:FitResponse):Promise<boolean>;
  retryFeedbackSync(userId:string,leaseId:string,retryAt:number):Promise<void>;
}
interface Options {now?:()=>number;timeoutMs?:number;leaseMs?:number;pollMs?:number;retryMs?:number;onError?:(code:string)=>void}
/** D enqueues in the settlement transaction; C1 fits its authoritative frozen snapshot. */
export class FeedbackWorker {
  private readonly workerId=crypto.randomUUID();
  private readonly now:()=>number;
  private readonly timeoutMs:number;
  private readonly leaseMs:number;
  private timer:ReturnType<typeof setInterval>|undefined;
  private running:Promise<void>|undefined;
  private stopped=false;
  constructor(private readonly repository:FeedbackRepository,private readonly ml:{fit(userId:string):Promise<FitResponse>},private readonly options:Options={}) {
    this.now=options.now??Date.now;this.timeoutMs=options.timeoutMs??45000;this.leaseMs=options.leaseMs??120000;
    if(this.timeoutMs<=0 || this.leaseMs<=this.timeoutMs+1000)throw new Error('Feedback deadline must leave time to settle its lease');
  }
  async runOnce():Promise<boolean> {
    const lease=await this.repository.claimFeedbackSync(this.workerId,this.now(),this.leaseMs);if(!lease)return false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const response=FitResponseSchema.parse(await Promise.race([this.ml.fit(lease.userId),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('ML deadline exceeded')),this.timeoutMs);})]));
      if(response.userId!==lease.userId || response.feedbackRevision<lease.feedbackRevision)throw new Error('Fit did not acknowledge the claimed revision');
      // A newer settlement stays pending in D; stale lease cannot clear another claim.
      if(!await this.repository.acknowledgeFeedbackSync(lease.userId,lease.leaseId,response.feedbackRevision,response))this.options.onError?.('FEEDBACK_LEASE_LOST');
    } catch {
      this.options.onError?.('FEEDBACK_SYNC_RETRY');
      await this.repository.retryFeedbackSync(lease.userId,lease.leaseId,this.now()+(this.options.retryMs??30000));
    } finally {clearTimeout(timer);}
    return true;
  }
  kick() {
    if(this.running || this.stopped)return;
    this.running=(async()=>{for(let count=0;count<10 && !this.stopped;count++)if(!await this.runOnce())break;})()
      .catch(()=>{this.options.onError?.('FEEDBACK_WORKER_UNAVAILABLE');}).finally(()=>{this.running=undefined;});
  }
  start() {if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>this.kick(),this.options.pollMs??5000);this.timer.unref();this.kick();}
  async close() {this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.running;}
}
