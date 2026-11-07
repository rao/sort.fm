import {ReviewRequestSchema,UndoRequestSchema,type ReviewRequest,type UndoRequest,type ReviewResult} from '@sortfm/contracts';
import {digest} from '../auth/crypto';
import {SpotifyError} from '../spotify/errors';
import {WRITE_SCOPES} from '../spotify/mutations';
import type {ReviewRepository} from './store';

export class ReviewService {
  constructor(private readonly repository:ReviewRepository,private readonly options:{auth:{requireScopes(userId:string,scopes:readonly string[]):Promise<void>};worker:{kick():void};now?:()=>number}) {}
  private now(){return new Date((this.options.now??Date.now)()).toISOString();}
  async decide(userId:string,input:ReviewRequest):Promise<ReviewResult> {
    const request=ReviewRequestSchema.parse(input);
    const existing=await this.repository.getDecisionByIdempotencyKey(userId,request.idempotencyKey);
    if(existing) {
      if(existing.trackId!==request.trackId || existing.action!==request.action || existing.exposureId!==request.exposureId)throw new SpotifyError('IDEMPOTENCY_CONFLICT','This request key was already used for a different action.',409);
      this.options.worker.kick();return existing;
    }
    const exposure=await this.repository.getExposure(userId,request.exposureId);
    if(!exposure || exposure.exposure.trackId!==request.trackId)throw new SpotifyError('EXPOSURE_NOT_FOUND','Review a track from your current queue.',404);
    const row=(await this.repository.library(userId)).find(row=>row.track.trackId===request.trackId);
    if(!row || row.track.source!=='spotify' || !row.track.isPlayable || !['saved','deferred'].includes(row.currentStatus))throw new SpotifyError('TRACK_NOT_REVIEWABLE','This track is no longer available in your review queue.',409);
    if(row.currentDecision && Date.parse(exposure.exposure.servedAt)<=Date.parse(row.currentDecision.updatedAt))throw new SpotifyError('STALE_EXPOSURE','Reload the queue before reviewing this track again.',409);
    if(request.action==='ARCHIVE')await this.options.auth.requireScopes(userId,WRITE_SCOPES);
    if(request.action==='UNLIKE')await this.options.auth.requireScopes(userId,['user-library-modify']);
    const result=await this.repository.createDecision({userId,decisionId:crypto.randomUUID(),request,requestFingerprint:digest(JSON.stringify(request)),createdAt:this.now()});
    this.options.worker.kick();return result;
  }
  async undo(userId:string,decisionId:string,input:UndoRequest):Promise<ReviewResult> {
    const request=UndoRequestSchema.parse(input),existing=await this.repository.getUndoByIdempotencyKey(userId,request.idempotencyKey);
    if(existing && existing.decisionId!==decisionId)throw new SpotifyError('IDEMPOTENCY_CONFLICT','This request key was already used for a different Undo.',409);
    const result=await this.repository.getDecision(userId,decisionId);
    if(!result)throw new SpotifyError('DECISION_NOT_FOUND','This decision was not found.',404);
    if(existing && result.status==='UNDONE')return result;
    if(!existing) {
      if(!result.canUndo || result.status!=='COMPLETE')throw new SpotifyError('UNDO_NOT_AVAILABLE','This decision is not ready to undo.',409);
      if(['ARCHIVE','UNLIKE'].includes(result.action))await this.options.auth.requireScopes(userId,['user-library-modify']);
      await this.repository.createUndo({userId,commandId:crypto.randomUUID(),decisionId,request,requestFingerprint:digest(JSON.stringify({decisionId,...request})),createdAt:this.now()});
    }
    this.options.worker.kick();
    // Original COMPLETE remains true until restoration succeeds. Never return it
    // as success for the Undo command or invent a temporary revoked model label.
    throw new SpotifyError('UNDO_PENDING','Undo is saved and awaiting confirmation. Retry with the same request key.',409,true);
  }
  async history(userId:string){return {items:await this.repository.history(userId,1000),nextCursor:null};}
}
