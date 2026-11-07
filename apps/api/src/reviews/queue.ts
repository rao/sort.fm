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
  score?:(userId:string,candidates:ScoringCandidate[],modelVersion?:string|null)=>Promise<ScoreResponse>;
  /** One total deadline for pool scoring and the pinned selected-page snapshot. */
  scoreTimeoutMs?:number;
}
const baseline = ():Prediction => ({modelKind:'untrained',modelVersion:'queue:metadata:v1',featureVersion:FEATURE_VERSION,trainedExamples:0,removalProbability:null,heuristicScore:null,uncertainty:null,uncertaintyMethod:'none',calibrated:false,explanations:[]});
// Default does not infer training permission. Runtime may inject the C1 assembler
// with the explicitly configured rights basis. Missing audio remains missing.
function assemble(rows:LibraryRow[],{now}:{now:number}):ScoringCandidate[] {
  return rows.map(({track})=>({trackId:track.trackId,features:{featureVersion:FEATURE_VERSION,provenance:'spotify',permittedForTraining:false,values:{duration_ms:track.durationMs,saved_age_days:Math.max(0,(now-Date.parse(track.originalAddedAt))/86_400_000)}}}));
}
async function bounded<T>(operation:()=>Promise<T>,deadline:number):Promise<T> {
  const remaining=deadline-performance.now();
  if(remaining<=0) throw new Error('Score deadline exceeded');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const value=await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Score deadline exceeded')),remaining);})]);
    if(performance.now()>deadline) throw new Error('Score deadline exceeded');
    return value;
  } finally {clearTimeout(timer);}
}
function group(a:LibraryRow,b:LibraryRow):number {
  return Number(a.currentStatus==='deferred')-Number(b.currentStatus==='deferred');
}
function stable(a:LibraryRow,b:LibraryRow):number {
  return group(a,b) || a.track.originalAddedAt.localeCompare(b.track.originalAddedAt) || a.track.trackId.localeCompare(b.track.trackId);
}
function validateScores(value:ScoreResponse,userId:string,candidates:ScoringCandidate[],version?:string):{version:string;scores:Map<string,Prediction>} {
  const response=ScoreResponseSchema.parse(value);
  const scores=new Map(response.predictions.map(item=>[item.trackId,item.prediction]));
  const first=response.predictions[0]?.prediction;
  if(!response.modelVersion || response.userId!==userId || (version!==undefined && response.modelVersion!==version)
    || scores.size!==candidates.length || response.predictions.length!==candidates.length || candidates.some(c=>!scores.has(c.trackId))
    || response.predictions.some(({prediction:p})=>p.modelVersion!==response.modelVersion || p.modelKind!==first?.modelKind || p.trainedExamples!==first?.trainedExamples)) {
    throw new Error('Score snapshot identity mismatch');
  }
  return {version:response.modelVersion,scores};
}
// BLAS may round batch and single-row predictions differently. Permit only tiny
// numeric roundoff; descriptions, feature names, nulls and model identity are exact.
function sameSnapshot(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(typeof a==='number'&&typeof b==='number')return Math.abs(a-b)<=1e-12;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)!==Array.isArray(b))return false;
  const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
  const keys=Object.keys(left);
  return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameSnapshot(left[key],right[key]));
}

/** C1 removal ranking; C2 exploration remains a separate policy integration. */
export class QueueService {
  constructor(private readonly repository:QueueRepository,private readonly options:QueueOptions={}) {
    const timeout=options.scoreTimeoutMs??2000;
    if(!Number.isFinite(timeout)||timeout<=0||timeout>2_147_483_647)throw new Error('Invalid queue score deadline');
  }
  async get(userId:string,input:{limit:number;policy:QueuePolicy;mode:'spotify'|'demo'}):Promise<QueueResult> {
    const query=QueueQuerySchema.parse(input);
    if(query.mode!=='spotify') throw new SpotifyError('MODE_NOT_SUPPORTED','Use the explicit demo endpoint for demo data.',400);
    const library=[...new Map((await this.repository.library(userId)).filter(row=>row.track.source==='spotify').map(row=>[row.track.trackId,row])).values()];
    const rows=library.filter(row=>row.track.isPlayable && ['saved','deferred'].includes(row.currentStatus) && (!row.currentDecision || ['COMPLETE','UNDONE','FAILED_TERMINAL'].includes(row.currentDecision.status))).sort(stable);
    const now=(this.options.now??Date.now)();
    // Context such as artist counts comes from the full current library, including
    // kept tracks. Only eligible rows enter ranking. No scorer can mutate snapshots.
    const assembled=(this.options.assemble??assemble)(library,{userId,now});
    const byId=new Map(assembled.map(candidate=>[candidate.trackId,candidate]));
    if(byId.size!==library.length || assembled.length!==library.length || library.some(row=>!byId.has(row.track.trackId))) throw new Error('Candidate assembly must preserve queue identity');
    const pool=rows.map(({track})=>({trackId:track.trackId,features:FeatureVectorSchema.parse(byId.get(track.trackId)!.features)}));
    const featuresById=new Map(pool.map(candidate=>[candidate.trackId,candidate.features]));
    const expose=(selected:LibraryRow[])=>selected.map(({track})=>({trackId:track.trackId,features:featuresById.get(track.trackId)!,exposureId:crypto.randomUUID()}));
    let selected=rows.slice(0,query.limit), candidates=expose(selected);
    let predictions=new Map<string,Prediction>(), learned=false;
    let fallbackReason:string|null='Personalized scoring is unavailable; using stable library order.';
    if(this.options.score && pool.length>10000){
      // Frozen ScoreRequest caps batches at 10,000. Never silently rank a prefix.
      fallbackReason='Eligible pool exceeds the scoring batch limit; using stable library order.';
    } else if(this.options.score && pool.length){
      const score=this.options.score;
      const deadline=performance.now()+(this.options.scoreTimeoutMs??2000);
      try {
        // No exposure IDs here: evaluating thousands of unserved alternatives must
        // not create durable observations or grow the explain store on every read.
        const ranked=validateScores(await bounded(()=>score(userId,structuredClone(pool),null),deadline),userId,pool);
        learned=[...ranked.scores.values()].every(p=>['logistic','sgd_logistic'].includes(p.modelKind)&&p.removalProbability!==null);
        if(!learned && [...ranked.scores.values()].some(p=>!['untrained','heuristic'].includes(p.modelKind)||p.removalProbability!==null))throw new Error('Unsupported ranking model');
        selected=(learned?[...rows].sort((a,b)=>group(a,b)
          || ranked.scores.get(b.track.trackId)!.removalProbability!-ranked.scores.get(a.track.trackId)!.removalProbability!
          || stable(a,b)):rows).slice(0,query.limit);
        candidates=expose(selected);
        const pinned=validateScores(await bounded(()=>score(userId,structuredClone(candidates),ranked.version),deadline),userId,candidates,ranked.version);
        if(candidates.some(c=>!sameSnapshot(ranked.scores.get(c.trackId),pinned.scores.get(c.trackId))))throw new Error('Score snapshot changed');
        if(performance.now()>deadline)throw new Error('Score deadline exceeded');
        predictions=pinned.scores;
        fallbackReason=learned
          ? (query.policy==='balanced'?null:'Using C1 removal ranking; policy-specific exploration is not installed.')
          : 'No learned probabilities are available; using stable library order.';
      } catch {
        // A timed-out keyed scorer may still store its prediction. Restore baseline
        // order AND issue fresh IDs so /explain cannot contradict served cards.
        selected=rows.slice(0,query.limit);candidates=expose(selected);
        predictions=new Map();learned=false;
        fallbackReason='Personalized scoring is unavailable; using stable library order.';
      }
    }
    const items=selected.map(({track},position)=>{
      const prediction=predictions.get(track.trackId)??baseline();
      const exposure={exposureId:candidates[position]!.exposureId,trackId:track.trackId,policy:query.policy,selectionMethod:learned?'logistic_rank' as const:'deterministic_baseline' as const,policyVersion:learned?'queue:c1-removal:v1':'queue:stable-library:v1',explorationCoefficient:0,propensityEstimate:null,modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,removalScore:prediction.removalProbability,heuristicScore:prediction.heuristicScore,uncertainty:prediction.uncertainty,position,servedAt:new Date(now).toISOString()};
      return {track,prediction,exposure};
    });
    const result=QueueResultSchema.parse({contractVersion:CONTRACT_VERSION,mode:'spotify',items,remaining:rows.length,nextCursor:null,fallbackReason:items.length?fallbackReason:null});
    // Await durability before exposing IDs to a browser; partial writes are harmless
    // immutable observations if a later insert fails. Never return an unpersisted ID.
    for(const [index,item] of items.entries()) await this.repository.insertExposure({userId,exposure:item.exposure,prediction:item.prediction,features:candidates[index]!.features});
    return result;
  }
}
