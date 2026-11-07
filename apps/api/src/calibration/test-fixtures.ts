import type {CalibrationStore,CalibrationLibraryRow,CalibrationLabelResult,ExposureInput,Prediction} from '@sortfm/contracts';
import {FEATURE_VERSION} from '@sortfm/contracts';
export const now=Date.parse('2026-11-07T12:00:00Z'),owner='spotify:calibration-test';
export function row(n:number):CalibrationLibraryRow {
 const trackId=String(n).padStart(22,'0');
 return {track:{trackId,source:'spotify',spotifyUri:`spotify:track:${trackId}`,title:`Fixture ${n}`,artists:[{id:`artist-${n%10}`,name:`Artist ${n%10}`}],album:'Fixture',imageUrl:null,durationMs:120000+n,explicit:false,originalAddedAt:new Date(Date.UTC(2020,0,n)).toISOString(),releaseDate:null,isPlayable:true},currentStatus:'saved',audioFeatures:null,currentDecision:null};
}
export const prediction:Prediction={modelKind:'logistic',modelVersion:'test:model',featureVersion:FEATURE_VERSION,trainedExamples:30,removalProbability:.8,heuristicScore:null,uncertainty:.5,uncertaintyMethod:'entropy',calibrated:false,explanations:[]};
export function fixture(rows=[row(1),row(2)]){
 const exposures:ExposureInput[]=[],labels:CalibrationLabelResult[]=[],calls:{method:string;value:unknown}[]=[];
 const store:CalibrationStore={
  calibrationCandidates:async userId=>{calls.push({method:'candidates',value:userId});return {library:structuredClone(rows),eligibleTrackIds:rows.map(r=>r.track.trackId)};},
  insertCalibrationExposure:async input=>{calls.push({method:'exposure',value:input.userId});exposures.push(structuredClone(input));},
  createCalibrationLabel:async input=>{
   calls.push({method:'label',value:structuredClone(input)});
   const prior=labels.find(l=>l.idempotencyKey===input.request.idempotencyKey);if(prior)return structuredClone(prior);
   const result:CalibrationLabelResult={mode:'calibration',labelId:input.labelId,...input.request,submittedLabel:input.request.label,state:'active',canUndo:true,feedbackRevision:labels.length+1,createdAt:input.createdAt,updatedAt:input.createdAt};
   labels.push(result);return structuredClone(result);
  },
  undoCalibrationLabel:async input=>{
   calls.push({method:'undo',value:structuredClone(input)});const old=labels.find(l=>l.labelId===input.labelId)!;
   Object.assign(old,{state:'revoked',label:null,canUndo:false,feedbackRevision:old.feedbackRevision+1,updatedAt:input.createdAt});return structuredClone(old);
  },
  calibrationHistory:async userId=>{calls.push({method:'history',value:userId});return {items:structuredClone(labels),nextCursor:null};},
 };
 return {store,rows,exposures,labels,calls};
}
