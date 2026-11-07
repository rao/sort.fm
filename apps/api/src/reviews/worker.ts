import {labelForAction,type ReviewResult} from '@sortfm/contracts';
import {feedbackSplit} from '../ml';
import {MutationRequestError,WRITE_SCOPES,type SpotifyMutations} from '../spotify/mutations';
import {safeError,SpotifyError} from '../spotify/errors';
import type {ReviewRepository,ReviewLease,EffectRequest} from './store';
export type ReviewSpotify=Pick<SpotifyMutations,'marker'|'findArchive'|'createArchive'|'verifyArchive'|'archiveContains'|'addArchive'|'isLiked'|'setLiked'>;
interface Options {auth:{requireScopes(userId:string,scopes:readonly string[]):Promise<void>};now?:()=>number;leaseMs?:number;pollMs?:number;retryMs?:number;feedback?:{kick():void};onError?:(code:string)=>void}
const unresolved=()=>new SpotifyError('SPOTIFY_WRITE_UNCONFIRMED','Spotify state is not yet confirmed. Reconciliation will retry without repeating an uncertain playlist write.',503,true);
export class ReviewWorker {
  private readonly workerId=crypto.randomUUID();private readonly now:()=>number;private readonly leaseMs:number;
  private timer:ReturnType<typeof setInterval>|undefined;private running:Promise<void>|undefined;private stopped=false;
  constructor(private readonly repository:ReviewRepository,private readonly spotify:ReviewSpotify,private readonly options:Options) {this.now=options.now??Date.now;this.leaseMs=options.leaseMs??120000;if(this.leaseMs<3000)throw new Error('Review lease too short');}
  private timestamp(){return new Date(this.now()).toISOString();}
  private async transition(lease:ReviewLease,status:ReviewResult['status'],step:ReviewResult['mutationStep'],archivePlaylistId:string|null=lease.mutation?.archivePlaylistId??null) {
    const next={userId:lease.userId,decisionId:lease.decisionId,mutationId:lease.mutation?.mutationId??crypto.randomUUID(),expectedStatus:lease.mutation?.status??'PENDING',status,step,attempts:(lease.mutation?.attempts??0)+1,archivePlaylistId,occurredAt:this.timestamp()};
    await this.repository.transitionMutation(next,lease);lease.mutation=next;
  }
  private async settle(lease:ReviewLease,changes:Partial<ReviewResult>) {
    for(let attempt=0;attempt<3;attempt++) {
      const snapshot=await this.repository.trainingExamples(lease.userId),next={...lease.result,...changes,updatedAt:this.timestamp()};
      const prior=snapshot.examples.find(example=>example.trackId===next.trackId && example.decisionId!==next.decisionId);
      next.feedbackRevision=snapshot.feedbackRevision+(lease.result.labelState!==next.labelState || (next.status==='COMPLETE'&&!!prior)?1:0);
      try {await this.repository.settleDecision(lease.userId,next,lease.result.status,feedbackSplit(lease.userId,next.trackId),lease);lease.result=next;this.options.feedback?.kick();return;}
      catch(error) {if(attempt===2 || !(error && typeof error==='object' && 'code' in error && error.code==='REVISION_CONFLICT'))throw error;}
    }
  }
  private async effect(lease:ReviewLease,request:EffectRequest,write:()=>Promise<string>):Promise<string> {
    const {effect,shouldExecute}=await this.repository.beginReviewEffect(lease,request);
    if(!shouldExecute) {if(effect.state==='confirmed' && effect.remoteId)return effect.remoteId;throw unresolved();}
    try {const remoteId=await write();await this.repository.settleReviewEffect(lease,request.kind,'confirmed',remoteId);return remoteId;}
    catch(error) {
      if(error instanceof MutationRequestError && error.outcome==='rejected')await this.repository.settleReviewEffect(lease,request.kind,'retryable',null);
      throw error;
    }
  }
  private async archive(lease:ReviewLease,guard:()=>Promise<void>):Promise<string> {
    const userId=lease.userId,trackId=lease.result.trackId;
    let playlist=await this.repository.getArchivePlaylist(userId);
    if(!playlist) {
      playlist=await this.spotify.findArchive(userId);
      if(playlist) {
        const existing=await this.repository.getReviewEffect(lease,'create_archive');
        if(existing)await this.repository.settleReviewEffect(lease,'create_archive','confirmed',playlist);
        else await this.repository.setArchivePlaylist(userId,playlist,lease);
      } else playlist=await this.effect(lease,{kind:'create_archive',name:'sort.fm Archive',public:false,description:this.spotify.marker(userId)},()=>this.spotify.createArchive(userId,guard));
    }
    await this.spotify.verifyArchive(userId,playlist);
    if(await this.spotify.archiveContains(userId,playlist,trackId)) {
      const existing=await this.repository.getReviewEffect(lease,'add_archive');
      if(existing)await this.repository.settleReviewEffect(lease,'add_archive','confirmed',playlist);
    } else {
      await this.effect(lease,{kind:'add_archive',playlistId:playlist,trackId},async()=>{
        await this.spotify.verifyArchive(userId,playlist!);await this.spotify.addArchive(userId,playlist!,trackId,guard);return playlist!;
      });
      if(!await this.spotify.archiveContains(userId,playlist,trackId))throw unresolved();
    }
    await this.transition(lease,'PENDING','ARCHIVED_PLAYLIST_INSERTED',playlist);return playlist;
  }
  async runOnce():Promise<boolean> {
    const lease=await this.repository.claimReviewWork(this.workerId,this.now(),this.leaseMs);if(!lease)return false;
    if((lease.operation==='review' && ['COMPLETE','UNDONE','FAILED_TERMINAL'].includes(lease.result.status)) || (lease.operation==='undo' && lease.result.status==='UNDONE')) {await this.repository.completeReviewWork(lease.userId,lease.leaseId);return true;}
    let lost=false,renewing:Promise<void>|undefined;
    const guard=async()=>{if(lost || !await this.repository.renewReviewWork(lease.userId,lease.leaseId,this.leaseMs)){lost=true;throw new SpotifyError('REVIEW_LEASE_LOST','Another worker owns this action.',409,true);}};
    const heartbeat=setInterval(()=>{if(!renewing)renewing=guard().catch(()=>{lost=true;}).finally(()=>{renewing=undefined;});},Math.min(30000,Math.floor(this.leaseMs/3)));heartbeat.unref();
    try {
      await guard();await this.options.auth.requireScopes(lease.userId,['user-library-read']);
      const result=lease.result,destructive=['ARCHIVE','UNLIKE'].includes(result.action);
      if(lease.operation==='undo') {
        if(destructive) {
          await this.options.auth.requireScopes(lease.userId,['user-library-modify']);
          if(!await this.spotify.isLiked(lease.userId,result.trackId))await this.spotify.setLiked(lease.userId,result.trackId,true,guard);
          if(!await this.spotify.isLiked(lease.userId,result.trackId))throw unresolved();
          await this.transition(lease,'UNDONE','RESTORED');
        }
        await this.settle(lease,{status:'UNDONE',mutationStep:destructive?'RESTORED':'NONE',liked:destructive?true:result.liked,canUndo:false,label:null,labelState:'revoked',error:null});
      } else {
        let playlist:string|null=null;
        if(destructive) {
          await this.options.auth.requireScopes(lease.userId,result.action==='ARCHIVE'?WRITE_SCOPES:['user-library-modify']);
          if(!lease.mutation)await this.transition(lease,'PENDING','PENDING');
          if(result.action==='ARCHIVE')playlist=await this.archive(lease,guard);
          if(playlist) {await this.spotify.verifyArchive(lease.userId,playlist);if(!await this.spotify.archiveContains(lease.userId,playlist,result.trackId))throw unresolved();}
          if(await this.spotify.isLiked(lease.userId,result.trackId))await this.spotify.setLiked(lease.userId,result.trackId,false,guard);
          if(await this.spotify.isLiked(lease.userId,result.trackId))throw unresolved();
          await this.transition(lease,'COMPLETE','UNLIKED',playlist);
        }
        const label=labelForAction(result.action);
        await this.settle(lease,{status:'COMPLETE',mutationStep:destructive?'UNLIKED':'NONE',liked:destructive?false:null,archived:result.action==='ARCHIVE'?true:null,canUndo:true,label,labelState:label===null?'inactive':'active',error:null});
      }
      await this.repository.completeReviewWork(lease.userId,lease.leaseId);
    } catch(error) {
      const safe=safeError(error);this.options.onError?.(safe.code);
      // Once a mutation journal exists, remote state may already have changed.
      // Even a terminal read/auth failure must remain resumable after reconnect.
      const retryable=safe.retryable || !!lease.mutation || ['AUTHENTICATION_REQUIRED','ACCOUNT_NOT_ALLOWED','SPOTIFY_SCOPE_REQUIRED','SPOTIFY_REAUTH_REQUIRED','SPOTIFY_FORBIDDEN','SPOTIFY_UNAUTHORIZED'].includes(safe.code);
      if(!lost) {
        try {
          if(lease.operation==='review' && !['COMPLETE','UNDONE'].includes(lease.result.status)) {
            await this.settle(lease,{status:retryable?'FAILED_RETRYABLE':'FAILED_TERMINAL',mutationStep:lease.mutation?.step==='ARCHIVED_PLAYLIST_INSERTED'?'ARCHIVED_PLAYLIST_INSERTED':'RECONCILING',canUndo:false,label:null,labelState:'inactive',error:{...safe.envelope(),retryable}});
            if(!retryable){await this.repository.completeReviewWork(lease.userId,lease.leaseId);return true;}
          }
          // Undo retains the prior active label until restoration is confirmed.
          await this.repository.retryReviewWork(lease.userId,lease.leaseId,Math.max(this.now()+(this.options.retryMs??30000),safe.retryAt??0));
        } catch {this.options.onError?.('REVIEW_RETRY_PERSISTENCE_FAILED');} // Lease expiry recovers if DB is down.
      }
    } finally {clearInterval(heartbeat);await renewing;}
    return true;
  }
  kick() {if(this.running||this.stopped)return;this.running=(async()=>{for(let i=0;i<20&&!this.stopped;i++)if(!await this.runOnce())break;})().catch(()=>this.options.onError?.('REVIEW_WORKER_UNAVAILABLE')).finally(()=>{this.running=undefined;});}
  start(){if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>this.kick(),this.options.pollMs??2000);this.timer.unref();this.kick();}
  async close(){this.stopped=true;clearInterval(this.timer);this.timer=undefined;await this.running;}
}
