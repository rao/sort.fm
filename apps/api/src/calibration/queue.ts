import {CALIBRATION_SELECTION_POLICY as POLICY,selectDiverseCalibrationRows} from './selection';
import {CONTRACT_VERSION,FEATURE_VERSION,CalibrationQueueQuerySchema,CalibrationQueueResultSchema,FeatureVectorSchema,IdSchema,ScoreResponseSchema,type CalibrationStore,type CalibrationLibraryRow,type ScoringCandidate,type ScoreResponse,type Prediction} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../ml/features';
import {CalibrationError} from './errors';
export interface CalibrationQueueOptions {
 now?:()=>number;
 assemble?:(rows:CalibrationLibraryRow[],context:{userId:string;now:number})=>ScoringCandidate[];
 score?:(userId:string,candidates:ScoringCandidate[])=>Promise<ScoreResponse>;
 scoreTimeoutMs?:number;
}
const baseline=():Prediction=>({modelKind:'untrained',modelVersion:'calibration:metadata:v1',featureVersion:FEATURE_VERSION,trainedExamples:0,removalProbability:null,heuristicScore:null,uncertainty:null,uncertaintyMethod:'none',calibrated:false,explanations:[]});
const badSnapshot=()=>new CalibrationError('CALIBRATION_INVALID_SNAPSHOT','Calibration candidates could not be verified. Refresh and try again.',503,true);
export class CalibrationQueue {
 constructor(private readonly store:CalibrationStore,private readonly options:CalibrationQueueOptions={}){
  const ms=options.scoreTimeoutMs??2000;if(!Number.isInteger(ms)||ms<=0||ms>2_147_483_647)throw new RangeError('Invalid calibration scoring timeout');
 }
 async get(userId:string,input:{limit:number}){
  IdSchema.parse(userId);const query=CalibrationQueueQuerySchema.parse(input),snapshot=await this.store.calibrationCandidates(userId);
  const byId=new Map(snapshot.library.map(row=>[row.track.trackId,row]));
  const eligible=new Set(snapshot.eligibleTrackIds);
  if(byId.size!==snapshot.library.length||eligible.size!==snapshot.eligibleTrackIds.length)throw badSnapshot();
  const rows=snapshot.eligibleTrackIds.map(id=>{
   const row=byId.get(id);
   if(!row||row.track.source!=='spotify'||!row.track.isPlayable||!['saved','deferred'].includes(row.currentStatus)
    ||(row.currentDecision&&!['UNDONE','FAILED_TERMINAL'].includes(row.currentDecision.status)))throw badSnapshot();
   return row;
  });
  const now=(this.options.now??Date.now)(),context={userId,now};
  const assembled=this.options.assemble?this.options.assemble(snapshot.library,context):assembleLibraryCandidates(snapshot.library,{userId,now:new Date(now).toISOString()});
  const features=new Map(assembled.map(c=>[c.trackId,c.features]));
  if(features.size!==byId.size||assembled.length!==byId.size||snapshot.library.some(r=>!features.has(r.track.trackId)))throw badSnapshot();
  const selected=selectDiverseCalibrationRows(rows,userId,query.limit);
  const candidates=selected.map(row=>({trackId:row.track.trackId,features:FeatureVectorSchema.parse(features.get(row.track.trackId)),exposureId:crypto.randomUUID()}));
  let predictions=new Map<string,Prediction>(),fallbackReason:string|null='Personalized scoring is unavailable; calibration preferences can still be recorded.';
  if(this.options.score&&candidates.length){
   let timer:ReturnType<typeof setTimeout>|undefined;
   const deadline=performance.now()+(this.options.scoreTimeoutMs??2000);
   try{
    const response=ScoreResponseSchema.parse(await Promise.race([
     this.options.score(userId,structuredClone(candidates)),
     new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Scoring deadline exceeded')),Math.max(1,deadline-performance.now()));}),
    ]));
    const scores=new Map(response.predictions.map(p=>[p.trackId,p.prediction]));
    if(performance.now()>deadline||response.userId!==userId||!response.modelVersion||scores.size!==candidates.length||response.predictions.length!==candidates.length
     ||candidates.some(c=>!scores.has(c.trackId))||response.predictions.some(p=>p.prediction.modelVersion!==response.modelVersion))throw badSnapshot();
    predictions=scores;fallbackReason=null;
   }catch{
    // Late keyed scores may persist at ML. Fresh IDs ensure baseline /explain can
    // never collide with those abandoned predictions. Features were cloned above.
    for(const candidate of candidates)candidate.exposureId=crypto.randomUUID();
   }finally{clearTimeout(timer);}
  }
  const items=selected.map(({track},position)=>{
   const prediction=predictions.get(track.trackId)??baseline();
   return {track,prediction,exposure:{exposureId:candidates[position]!.exposureId,trackId:track.trackId,policy:'balanced' as const,
    selectionMethod:'deterministic_baseline' as const,policyVersion:POLICY,explorationCoefficient:0,propensityEstimate:null,
    modelVersion:prediction.modelVersion,featureVersion:FEATURE_VERSION,removalScore:prediction.removalProbability,heuristicScore:prediction.heuristicScore,
    uncertainty:prediction.uncertainty,position,servedAt:new Date(now).toISOString()}};
  });
  const result=CalibrationQueueResultSchema.parse({contractVersion:CONTRACT_VERSION,mode:'calibration',items,remaining:rows.length,nextCursor:null,fallbackReason:items.length?fallbackReason:null});
  // D rechecks purpose and current eligibility under its owner lock before insert.
  // A concurrent label may invalidate a partial page: do not return undurable IDs.
  for(const [i,item] of result.items.entries())await this.store.insertCalibrationExposure({userId,exposure:item.exposure,prediction:item.prediction,features:candidates[i]!.features});
  return result;
 }
}
