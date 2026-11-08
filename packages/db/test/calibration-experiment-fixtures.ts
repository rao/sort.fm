import {createIdempotencyKey} from '@sortfm/contracts/client';
import {createHash} from 'node:crypto';
import {calibrationExperimentCanonical,calibrationExperimentSeedPrecommit,CALIBRATION_BATCH3_EXPERIMENT,type CalibrationExperimentDraft,type CalibrationExperimentReservation,type CalibrationExperimentSealInput} from '@sortfm/contracts';
import {row,prediction} from '../../../apps/api/src/calibration/test-fixtures';
export const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export const hash=(v:unknown)=>sha(calibrationExperimentCanonical(v));
export function experimentDraft(n=80):CalibrationExperimentDraft{
 const candidates=Array.from({length:n},(_,i)=>({track:row(i+1).track,prediction,features:{featureVersion:'sortfm.features.v1' as const,provenance:'musicae' as const,permittedForTraining:true,values:{saved_age_days:i}}}));
 const batchId=crypto.randomUUID(),protocolVersion='batch3:v1',seed=42;
 const select=(i:number,group:'A'|'B')=>({trackId:candidates[i]!.track.trackId,group,assignment:group==='A'?'sealed_evaluation' as const:'train' as const,samplingMethod:group==='A'?'seeded_uniform':'coverage_distance',selectionScore:group==='A'?null:i,scoreKind:group==='A'?'seeded_random' as const:'coverage_distance' as const,selectionProbability:group==='A'?40/n:null});
 return {batchId,experiment:CALIBRATION_BATCH3_EXPERIMENT,protocolVersion,algorithmVersion:'batch3:v1',modelVersion:prediction.modelVersion,ownerRevision:{feedbackRevision:0,membershipRevision:1},selectedAt:new Date(Date.now()-1000).toISOString(),seedPrecommit:{seed,commitment:sha(calibrationExperimentSeedPrecommit(batchId,protocolVersion,seed)),committedAt:new Date(Date.now()-2000).toISOString(),artifactSha256:'a'.repeat(64)},research:{protocolSha256:'a'.repeat(64),trainingDataSha256:'b'.repeat(64),modelSealSha256:'c'.repeat(64)},exclusionLedger:{source:'synthetic',sortedTrackIds:[],sortedIdsSha256:hash([])},eligibleTrackIdsSha256:hash(candidates.map(c=>c.track.trackId)),candidates,selected:[...Array.from({length:40},(_,i)=>select(i,'A')),...Array.from({length:20},(_,i)=>select(i+40,'B'))],replacementPool:Array.from({length:n-40},(_,i)=>select(i+40,'B'))};
}
export function experimentSeal(d:CalibrationExperimentDraft,r:CalibrationExperimentReservation):CalibrationExperimentSealInput{
 const a=d.selected.slice(0,40).map(s=>d.candidates.find(c=>c.track.trackId===s.trackId)!);
 return {batchId:d.batchId,idempotencyKey:createIdempotencyKey(),expected:r.digests,research:d.research,externalSealedAt:new Date(Date.now()-100).toISOString(),evaluationCandidates:a.map(c=>({trackId:c.track.trackId,features:c.features})),queryGroups:Object.fromEntries(a.map(c=>[c.track.trackId,c.track.artists[0]?.id??null])),artifacts:{modelSealSha256:d.research.modelSealSha256,candidatesSha256:'d'.repeat(64),queryGroupsSha256:'d'.repeat(64),ownerManifestSha256:'d'.repeat(64),panelReviewSha256:'d'.repeat(64),predictionsSha256:'d'.repeat(64),queryAuditSha256:'d'.repeat(64),predictionSealSha256:'d'.repeat(64)}};
}
