import {CalibrationBatchCreateSchema,CalibrationBatchDraftSchema,CalibrationBatchSkipSchema,FeatureVectorSchema,IdSchema,ScoreResponseSchema,type CalibrationBatchStore,type CalibrationLibraryRow,type ScoringCandidate,type ScoreResponse} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../ml/features';
import {CalibrationError} from './errors';
import {BATCH_ALGORITHM,selectCalibrationBatch} from './batch-selection';
export interface CalibrationBatchOptions {
 now?:()=>number;
 assemble?:(rows:CalibrationLibraryRow[],context:{userId:string;now:number})=>ScoringCandidate[];
 score?:(userId:string,candidates:ScoringCandidate[],modelVersion?:string|null)=>Promise<ScoreResponse>;
 scoreTimeoutMs?:number;
}
/** Batch orchestration only. All provider/model I/O precedes the atomic reservation. */
export class CalibrationBatchService {
 constructor(private readonly store:CalibrationBatchStore,private readonly options:CalibrationBatchOptions={}){}
 private now(){return new Date((this.options.now??Date.now)()).toISOString();}
 read(userId:string){IdSchema.parse(userId);return this.store.calibrationBatch(userId,this.now());}
 async create(userId:string,input:{seed?:number}){
  IdSchema.parse(userId);const {seed}=CalibrationBatchCreateSchema.parse(input),selectedAt=this.now();
  const existing=await this.store.calibrationBatch(userId,selectedAt);
  if(existing){if(existing.seed!==seed)throw new CalibrationError('BATCH_SEED_CONFLICT','This batch already has a saved seed. Resume it to keep the original selection.',409);return existing;}
  const snapshot=await this.store.calibrationBatchCandidates(userId),eligible=new Set(snapshot.eligibleTrackIds);
  const byId=new Map(snapshot.library.map(r=>[r.track.trackId,r]));
  if(byId.size!==snapshot.library.length||eligible.size!==snapshot.eligibleTrackIds.length||[...eligible].some(id=>!byId.has(id)))throw new CalibrationError('BATCH_INVALID_SNAPSHOT','The candidate snapshot could not be verified.',503,true);
  if(eligible.size<70)throw new CalibrationError('BATCH_INSUFFICIENT_CANDIDATES','Batch 2 needs at least 70 never-reviewed eligible songs.',409);
  const context={userId,now:Date.parse(selectedAt)};
  const assembled=this.options.assemble?this.options.assemble(snapshot.library,context):assembleLibraryCandidates(snapshot.library,{userId,now:selectedAt});
  if(assembled.length!==byId.size||new Set(assembled.map(c=>c.trackId)).size!==byId.size||assembled.some(c=>!byId.has(c.trackId)))throw new CalibrationError('BATCH_INVALID_SNAPSHOT','The candidate snapshot could not be verified.',503,true);
  const candidates=assembled.filter(c=>eligible.has(c.trackId)).map(c=>({trackId:c.trackId,features:FeatureVectorSchema.parse(c.features)}));
  let response:ScoreResponse;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!this.options.score)throw Error('No scorer');
   response=ScoreResponseSchema.parse(await Promise.race([this.options.score(userId,structuredClone(candidates),null),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),this.options.scoreTimeoutMs??30000);})]));
   if(response.userId!==userId||response.predictions.length!==candidates.length||new Set(response.predictions.map(p=>p.trackId)).size!==candidates.length||response.predictions.some(p=>!eligible.has(p.trackId)||p.prediction.modelVersion!==response.modelVersion||!['logistic','sgd_logistic'].includes(p.prediction.modelKind)||p.prediction.removalProbability===null))throw Error('incoherent model');
  }catch{throw new CalibrationError('BATCH_SCORING_UNAVAILABLE','Batch 2 needs a complete frozen C1 probability snapshot. Retry when the trained model is available.',503,true);}finally{clearTimeout(timer);}
  const scores=new Map(response.predictions.map(p=>[p.trackId,p.prediction]));
  const frozen=candidates.map(c=>({track:byId.get(c.trackId)!.track,features:c.features,prediction:scores.get(c.trackId)!}));
  let selection:ReturnType<typeof selectCalibrationBatch>;
  try{selection=selectCalibrationBatch(frozen,seed);}catch{throw new CalibrationError('BATCH_INSUFFICIENT_AMBIGUITY','Fewer than 20 unused songs have sufficiently ambiguous frozen C1 probabilities. No partial batch was saved.',409);}
  return this.store.createCalibrationBatch(userId,CalibrationBatchDraftSchema.parse({batchId:crypto.randomUUID(),seed,selectedAt,algorithmVersion:BATCH_ALGORITHM,modelVersion:response.modelVersion,candidates:frozen,...selection}));
 }
 skip(userId:string,input:Parameters<CalibrationBatchStore['skipCalibrationBatch']>[1]){IdSchema.parse(userId);return this.store.skipCalibrationBatch(userId,CalibrationBatchSkipSchema.parse(input),this.now());}
}
