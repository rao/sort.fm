import {CONTRACT_VERSION, FEATURE_VERSION, FeatureVectorSchema, QueueQuerySchema, QueueResultSchema, ScoreResponseSchema, type ExposureInput, type FeatureVector, type Prediction, type QueuePolicy, type QueueResult, type ScoringCandidate, type ScoreResponse, type TrackCard, type ReviewResult, type SavedTrackInput} from '@sortfm/contracts';
import {SpotifyError} from '../spotify/errors';

export type LibraryRow = {track:TrackCard; currentStatus:SavedTrackInput['currentStatus']; audioFeatures:FeatureVector|null; currentDecision:ReviewResult|null};
export interface QueueRepository {
  library(userId:string):Promise<LibraryRow[]>;
  insertExposure(input:ExposureInput):Promise<void>;
}
export interface QueueOptions {
  now?:()=>number;
  assemble?:(rows:LibraryRow[],context:{userId:string;now:number})=>ScoringCandidate[];
  score?:(userId:string,candidates:ScoringCandidate[])=>Promise<ScoreResponse>;
  scoreTimeoutMs?:number;
}
const baseline = ():Prediction => ({modelKind:'untrained',modelVersion:'queue:metadata:v1',featureVersion:FEATURE_VERSION,trainedExamples:0,removalProbability:null,heuristicScore:null,uncertainty:null,uncertaintyMethod:'none',calibrated:false,explanations:[]});
// Default does not infer training permission. Runtime may inject the C1 assembler
// with the explicitly configured rights basis. Missing audio remains missing.
function assemble(rows:LibraryRow[],{now}:{now:number}):ScoringCandidate[] {
  return rows.map(({track})=>({trackId:track.trackId,features:{featureVersion:FEATURE_VERSION,provenance:'spotify',permittedForTraining:false,values:{duration_ms:track.durationMs,saved_age_days:Math.max(0,(now-Date.parse(track.originalAddedAt))/86_400_000)}}}));
}
async function bounded<T>(promise:Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Score deadline exceeded')),ms);})]);}
  finally {clearTimeout(timer);}
}

/** Stable baseline ordering; C2 owns learned selection. Scoring cannot block import or queue. */
export class QueueService {
  constructor(private readonly repository:QueueRepository,private readonly options:QueueOptions={}) {}
  async get(userId:string,input:{limit:number;policy:QueuePolicy;mode:'spotify'|'demo'}):Promise<QueueResult> {
    const query=QueueQuerySchema.parse(input);
    if(query.mode!=='spotify') throw new SpotifyError('MODE_NOT_SUPPORTED','Use the explicit demo endpoint for demo data.',400);
    const library=[...new Map((await this.repository.library(userId)).filter(row=>row.track.source==='spotify').map(row=>[row.track.trackId,row])).values()];
    const rows=library.filter(row=>row.track.isPlayable && ['saved','deferred'].includes(row.currentStatus) && (!row.currentDecision || ['COMPLETE','UNDONE','FAILED_TERMINAL'].includes(row.currentDecision.status)));
    rows.sort((a,b)=>Number(a.currentStatus==='deferred')-Number(b.currentStatus==='deferred') || a.track.originalAddedAt.localeCompare(b.track.originalAddedAt) || a.track.trackId.localeCompare(b.track.trackId));
    const selected=rows.slice(0,query.limit), now=(this.options.now??Date.now)();
    const assembled=(this.options.assemble??assemble)(library,{userId,now});
    const byId=new Map(assembled.map(candidate=>[candidate.trackId,candidate]));
    if(byId.size!==library.length || assembled.length!==library.length || library.some(row=>!byId.has(row.track.trackId))) throw new Error('Candidate assembly must preserve queue identity');
    const candidates=selected.map(({track})=>{
      const candidate=byId.get(track.trackId); if(!candidate) throw new Error('Missing queue feature snapshot');
      return {trackId:track.trackId,features:FeatureVectorSchema.parse(candidate.features),exposureId:crypto.randomUUID()};
    });
    let predictions=new Map<string,Prediction>();
    let fallbackReason='Using stable library order; learned queue selection is not installed.';
    if(this.options.score && candidates.length) {
      try {
        const response=ScoreResponseSchema.parse(await bounded(this.options.score(userId,structuredClone(candidates)),this.options.scoreTimeoutMs??2000));
        const scores=new Map(response.predictions.map(item=>[item.trackId,item.prediction]));
        if(response.userId!==userId || scores.size!==candidates.length || response.predictions.length!==candidates.length || candidates.some(c=>!scores.has(c.trackId)) || response.predictions.some(p=>p.prediction.modelVersion!==response.modelVersion)) throw new Error('Score snapshot identity mismatch');
        predictions=scores;
      } catch {
        // A timed-out scorer may still store its prediction. A baseline must never
        // reuse that identity or later /explain could contradict the served card.
        for(const candidate of candidates) candidate.exposureId=crypto.randomUUID();
        fallbackReason='Personalized scoring is unavailable; using stable library order.';
      }
    }
    const items=selected.map(({track},position)=>{
      const prediction=predictions.get(track.trackId)??baseline();
      const exposure={exposureId:candidates[position]!.exposureId,trackId:track.trackId,policy:query.policy,selectionMethod:'deterministic_baseline' as const,policyVersion:'queue:stable-library:v1',explorationCoefficient:0,propensityEstimate:null,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,removalScore:prediction.removalProbability,heuristicScore:prediction.heuristicScore,uncertainty:prediction.uncertainty,position,servedAt:new Date(now).toISOString()};
      return {track,prediction,exposure};
    });
    const result=QueueResultSchema.parse({contractVersion:CONTRACT_VERSION,mode:'spotify',items,remaining:rows.length,nextCursor:null,fallbackReason:items.length?fallbackReason:null});
    // Await durability before exposing IDs to a browser; partial writes are harmless
    // immutable observations if a later insert fails. Never return an unpersisted ID.
    for(const [index,item] of items.entries()) await this.repository.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:candidates[index]!.features});
    return result;
  }
}
