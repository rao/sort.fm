import type {CalibrationExperimentReserveInput} from './experiment-service';
import {createHash} from 'node:crypto';
import {CALIBRATION_BATCH3_EXPERIMENT,calibrationExperimentCanonical,calibrationExperimentSeedPrecommit,type CalibrationExperimentDraft,type CalibrationExperimentStore,type CalibrationExperimentSnapshot,type CalibrationExperimentReservation,type CalibrationExperimentReady} from '@sortfm/contracts';
import {assembleLibraryCandidates} from '../ml/features';
import {now,owner,row,prediction} from './test-fixtures';
export const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
export const digest=(v:unknown)=>sha(calibrationExperimentCanonical(v));
export function operatorInput():CalibrationExperimentReserveInput{const batchId=crypto.randomUUID(),protocolVersion='test:batch3:v1',seed=42;return {batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,protocolVersion,
 seedPrecommit:{seed,commitment:sha(calibrationExperimentSeedPrecommit(batchId,protocolVersion,seed)),committedAt:new Date(now-1000).toISOString(),artifactSha256:'a'.repeat(64)},
 research:{protocolSha256:'b'.repeat(64),trainingDataSha256:'c'.repeat(64),modelSealSha256:'d'.repeat(64)},
 exclusionLedger:{source:'fixture',sortedTrackIds:[] as string[],sortedIdsSha256:digest([])},
};}
export function reservation(draft:CalibrationExperimentDraft):CalibrationExperimentReservation{return {batchId:draft.batchId,experiment:draft.experiment,reservedAt:draft.selectedAt,ownerRevision:draft.ownerRevision,digests:{snapshotSha256:digest(draft),poolSha256:digest(draft.candidates),rosterSha256:digest(draft.selected),eligibleTrackIdsSha256:draft.eligibleTrackIdsSha256}};}
export function reserved(draft:CalibrationExperimentDraft){return {batchId:draft.batchId,experiment:draft.experiment,phase:'reserved' as const,reservedAt:draft.selectedAt,target:60 as const,groups:([{group:'A',target:40,reserved:40},{group:'B',target:20,reserved:20},{group:'C',target:0,reserved:0}] as const).map(g=>({...g}))};}
export function ready(draft:CalibrationExperimentDraft):CalibrationExperimentReady {return {...reserved(draft),phase:'ready',readyAt:new Date(now+1000).toISOString(),algorithmVersion:draft.algorithmVersion,modelVersion:draft.modelVersion,candidateCount:draft.candidates.length,labeled:0,trainingLabeled:0,sealedLabeled:0,
 groups:([{group:'A',target:40},{group:'B',target:20},{group:'C',target:0}] as const).map(g=>({...g,labeled:0,pending:g.target,skipped:0,revoked:0})),
 entries:draft.selected.map(s=>({...s,batchItemId:crypto.randomUUID(),exposureId:crypto.randomUUID(),selectedAt:draft.selectedAt,status:'pending',replacementFor:null})),queue:{contractVersion:'1.0.0',mode:'calibration',items:[],remaining:60,nextCursor:null,fallbackReason:null}};}
export function experimentFixture(){
 const rows=Array.from({length:90},(_,i)=>row(i+1)),calls:string[]=[];let saved:CalibrationExperimentSnapshot|null=null;
 const store:CalibrationExperimentStore={
  calibrationExperimentCandidates:async(user,ledger)=>{if(user!==owner)throw Error('owner');calls.push('candidates');return {library:structuredClone(rows),eligibleTrackIds:rows.slice(10).filter(r=>!ledger.sortedTrackIds.includes(r.track.trackId)).map(r=>r.track.trackId).reverse(),ownerRevision:{feedbackRevision:228,membershipRevision:1}};},
  calibrationExperimentSnapshot:async()=>{calls.push('snapshot');return structuredClone(saved);},
  reserveCalibrationExperiment:async(user,draft)=>{if(user!==owner)throw Error('owner');calls.push('reserve');saved={draft:structuredClone(draft),reservation:reservation(draft),seal:null};return structuredClone(saved.reservation);},
  calibrationExperiment:async()=>{calls.push('read');return saved?reserved(saved.draft):null;},
  sealCalibrationExperiment:async()=>{calls.push('seal');throw Error('operator fixture not sealed');},
  skipCalibrationExperiment:async()=>{calls.push('skip');if(!saved)throw Error('missing');return ready(saved.draft);},
 };
 const load=async(library:typeof rows,ctx:{userId:string;now:number})=>{calls.push('load');return {candidates:assembleLibraryCandidates(library,{userId:ctx.userId,now:new Date(ctx.now).toISOString(),metadataTraining:{permittedForTraining:true,rightsBasis:'Synthetic test fixture'}})};};
 const score=async(userId:string,candidates:{trackId:string}[])=>{calls.push('score');return {userId,modelVersion:prediction.modelVersion,featureVersion:prediction.featureVersion,predictions:candidates.map(c=>({trackId:c.trackId,prediction:{...prediction,removalProbability:.001}}))};};
 return {store,rows,calls,load,score,saved:()=>saved,setSaved:(value:CalibrationExperimentSnapshot|null)=>{saved=value;}};
}
