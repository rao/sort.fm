import {CONTRACT_VERSION,FEATURE_VERSION,ListeningContextSnapshotSchema,FeatureVectorSchema,PolicyConfigSchema,PolicySelectRequestSchema,QueueQuerySchema,QueueResultSchema,
  type AdaptiveSelectionDraft,type ExposureInput,type PolicyConfig,type PolicyStore,type QueuePolicy,type QueueResult,type ReviewCandidateSnapshot,type SelectionIntent} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../../ml/features';
import type {PolicyClient} from '../../ml/client';
import {SpotifyError} from '../../spotify/errors';
import {PersistenceError} from '@sortfm/db';
import {QueueService,type QueueOptions} from '../queue';
import {abandonSelection,publishAdaptive,releaseIdentity} from './selection';

type QueueStore=Pick<PolicyStore,'currentSelection'|'reviewCandidates'|'prepareSelection'|'publishSelection'|'releaseSelection'>;
export interface PolicyQueueOptions extends QueueOptions {
  enabled?:boolean;strategy?:'c1'|'epsilon_greedy'|'linucb';client?:PolicyClient;
  config?:Partial<Omit<PolicyConfig,'strategy'>>;seed?:number;
  selectionTimeoutMs?:number;leaseMs?:number;reservationMs?:number;
}
const fallbackVersion=(strategy:string)=>`queue:c1-fallback:${strategy}:v1`;

/** All algorithms use D's common eligibility and fenced, atomic publication. */
export class PolicyQueueService {
  private readonly now:()=>number;
  private readonly strategy:'c1'|'epsilon_greedy'|'linucb';
  private readonly timeout:number;
  private readonly leaseMs:number;
  private readonly reservationMs:number;
  private readonly assemble:NonNullable<QueueOptions['assemble']>;
  constructor(private readonly store:QueueStore,private readonly options:PolicyQueueOptions={}) {
    this.now=options.now??Date.now;
    this.strategy=options.enabled?options.strategy??'c1':'c1';
    this.timeout=options.selectionTimeoutMs??15000;this.leaseMs=options.leaseMs??60000;
    this.reservationMs=options.reservationMs??300000;
    if(!Number.isInteger(this.timeout)||this.timeout<=0||!Number.isInteger(this.leaseMs)||this.leaseMs>120000
      ||this.leaseMs<this.timeout+1000||!Number.isInteger(this.reservationMs)||this.reservationMs<30000||this.reservationMs>900000)throw new Error('Invalid policy queue deadlines');
    PolicyConfigSchema.parse({...options.config,strategy:this.strategy});
    this.assemble=options.assemble??((rows,context)=>assembleLibraryCandidates(rows,{...context,now:new Date(context.now).toISOString()}));
  }
  private compatible(intent:SelectionIntent):boolean {
    if(intent.draft.kind==='adaptive')return this.strategy===intent.draft.request.config.strategy&&Boolean(this.options.client);
    const fallback=intent.draft.items[0]?.exposure.policyVersion;
    return this.strategy==='c1'||fallback===fallbackVersion(this.strategy);
  }
  private render(intent:SelectionIntent,snapshot:ReviewCandidateSnapshot,limit:number):QueueResult {
    if(!intent.publication||!intent.replayable||Date.parse(intent.expiresAt)<=this.now())return this.empty(snapshot);
    const servable=new Set(intent.servableExposureIds),tracks=new Map(snapshot.library.map(row=>[row.track.trackId,row.track]));
    const items=intent.publication.items.filter(item=>servable.has(item.exposure.exposureId)&&tracks.has(item.exposure.trackId)).slice(0,limit)
      .map(item=>({track:tracks.get(item.exposure.trackId)!,exposure:item.exposure,prediction:item.prediction}));
    const fallback=items.some(i=>i.exposure.policyVersion.startsWith('queue:c1-fallback:'));
    return QueueResultSchema.parse({contractVersion:CONTRACT_VERSION,mode:'spotify',items,remaining:snapshot.remaining,nextCursor:null,
      fallbackReason:!items.length?null:fallback?'Policy selection is unavailable; using C1.':intent.draft.kind==='c1'&&items.every(i=>i.prediction.removalProbability===null)?'No learned probabilities are available; using stable library order.':null});
  }
  private empty(snapshot:ReviewCandidateSnapshot):QueueResult {
    return {contractVersion:CONTRACT_VERSION,mode:'spotify',items:[],remaining:snapshot.remaining,nextCursor:null,fallbackReason:null};
  }
  private async prepare(input:Parameters<QueueStore['prepareSelection']>[0]) {
    try {return await this.store.prepareSelection(input);}
    catch(error) {
      if(error instanceof PersistenceError&&error.code==='POLICY_SELECTION_BUSY') {
        throw new SpotifyError('POLICY_SELECTION_BUSY','A review selection is being prepared. Retry shortly.',409,true);
      }
      throw error;
    }
  }
  async get(userId:string,input:{limit:number;policy:QueuePolicy;mode:'spotify'|'demo'}):Promise<QueueResult> {
    const query=QueueQuerySchema.parse(input);
    if(query.mode!=='spotify')throw new SpotifyError('MODE_NOT_SUPPORTED','Use the explicit demo endpoint for demo data.',400);
    const current=await this.store.currentSelection(userId);
    if(current&&current.userId!==userId)throw new Error('POLICY_OWNER_MISMATCH');
    if(current?.replayable&&current.servableExposureIds.length) {
      if(this.compatible(current))return this.render(current,await this.store.reviewCandidates(userId),query.limit);
      await this.store.releaseSelection({userId,requestId:current.requestId,releaseId:releaseIdentity(current,`prefetch_discarded:${this.strategy}:${current.servableExposureIds.join(',')}`),
        exposureIds:current.servableExposureIds,reason:'prefetch_discarded'});
    }
    let snapshot=await this.store.reviewCandidates(userId);
    if(!snapshot.eligibleTrackIds.length)return this.empty(snapshot);
    if(this.strategy!=='c1'&&this.options.client&&snapshot.fitReceipt
      &&snapshot.fitReceipt.synchronizedFeedbackRevision===snapshot.feedbackRevision&&snapshot.eligibleTrackIds.length<=10000) {
      const rows=snapshot.library,ids=new Set(snapshot.eligibleTrackIds),at=this.now();
      const loaded=this.options.load?await this.options.load(structuredClone(rows),{userId,now:at}):{candidates:this.assemble(structuredClone(rows),{userId,now:at})};
      const assembled=loaded.candidates;
      const listeningContext=loaded.listeningContext===undefined?undefined:ListeningContextSnapshotSchema.parse(loaded.listeningContext);
      const assembledIds=new Set(assembled.map(c=>c.trackId));
      if(assembled.length!==rows.length||assembledIds.size!==rows.length
        ||rows.some(row=>!assembledIds.has(row.track.trackId))||snapshot.eligibleTrackIds.some(id=>!assembledIds.has(id)))throw new Error('Candidate assembly must preserve queue identity');
      const tracks=new Map(rows.map(row=>[row.track.trackId,row.track]));
      const config={...PolicyConfigSchema.parse({...this.options.config,strategy:this.strategy}),strategy:this.strategy};
      const request=PolicySelectRequestSchema.parse({userId,featureVersion:FEATURE_VERSION,exposureId:crypto.randomUUID(),
        modelVersion:snapshot.fitReceipt.modelVersion,feedbackRevision:snapshot.fitReceipt.synchronizedFeedbackRevision,
        seed:this.options.seed??42,config,candidates:assembled.filter(c=>ids.has(c.trackId)).map(c=>({trackId:c.trackId,
          features:FeatureVectorSchema.parse(c.features),artistIds:[...new Set(tracks.get(c.trackId)!.artists.flatMap(a=>a.id?[a.id]:[]))].slice(0,20)}))});
      const draft:AdaptiveSelectionDraft={kind:'adaptive',queuePolicy:query.policy,...(listeningContext?{listeningContext}:{}),request:{...request,
        modelVersion:snapshot.fitReceipt.modelVersion,feedbackRevision:snapshot.fitReceipt.synchronizedFeedbackRevision,config}};
      let intent:SelectionIntent|undefined;
      try {
        const prepared=await this.prepare({userId,requestId:crypto.randomUUID(),draft,
          feedbackRevision:snapshot.feedbackRevision,membershipRevision:snapshot.membershipRevision,leaseMs:this.leaseMs,reservationMs:this.reservationMs});
        if(prepared.outcome==='replay')return this.render(prepared.intent,await this.store.reviewCandidates(userId),query.limit);
        if(prepared.outcome!=='claimed')return this.empty(snapshot);
        intent=prepared.intent;
        const published=await publishAdaptive(this.store,this.options.client,intent,this.now,this.timeout);
        if(published.outcome!=='rejected')return this.render(published.intent,await this.store.reviewCandidates(userId),query.limit);
        // Rejection already schedules release under D's fence. A stale worker
        // must never close another worker's recovered publication.
      } catch(error) {
        // Another request owns the preparation. Do not create a competing C1
        // fallback or release work for an intent this request never acquired.
        if(error instanceof SpotifyError&&error.code==='POLICY_SELECTION_BUSY')throw error;
        if(intent)await abandonSelection(this.store,intent);
      }
      snapshot=await this.store.reviewCandidates(userId);
    }
    return this.c1(userId,query,snapshot,this.strategy!=='c1');
  }
  private async c1(userId:string,query:{limit:number;policy:QueuePolicy;mode:'spotify'|'demo'},snapshot:ReviewCandidateSnapshot,fallback:boolean):Promise<QueueResult> {
    if(!snapshot.eligibleTrackIds.length)return this.empty(snapshot);
    const allowed=new Set(snapshot.eligibleTrackIds),items:ExposureInput[]=[];
    const service=new QueueService({library:async()=>structuredClone(snapshot.library),
      reservedCalibrationTrackIds:async()=>snapshot.library.filter(row=>!allowed.has(row.track.trackId)).map(row=>row.track.trackId),
      insertExposure:async item=>{items.push(item);}},
      {...this.options,assemble:this.assemble});
    await service.get(userId,query);
    if(!items.length)return this.empty(snapshot);
    if(fallback)for(const item of items)item.exposure.policyVersion=fallbackVersion(this.strategy);
    const prepared=await this.prepare({userId,requestId:crypto.randomUUID(),draft:{kind:'c1',items},
      feedbackRevision:snapshot.feedbackRevision,membershipRevision:snapshot.membershipRevision,leaseMs:this.leaseMs,reservationMs:this.reservationMs});
    if(prepared.outcome==='replay')return this.render(prepared.intent,await this.store.reviewCandidates(userId),query.limit);
    if(prepared.outcome!=='claimed')return this.empty(snapshot);
    // C1 has no provider reservation. Ambiguous DB outcomes remain recoverable.
    const published=await this.store.publishSelection({userId,requestId:prepared.intent.requestId,leaseId:prepared.intent.lease.leaseId,kind:'c1'});
    if(published.outcome==='rejected')throw new SpotifyError('QUEUE_CHANGED','The review queue changed. Refresh to continue.',409,true);
    return this.render(published.intent,await this.store.reviewCandidates(userId),query.limit);
  }
}
