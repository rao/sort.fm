import {createHash} from 'node:crypto';
import {CalibrationHistorySchema,CalibrationLabelRequestSchema,CalibrationLabelResultSchema,IdSchema,UndoRequestSchema,UuidSchema,type CalibrationStore,type CalibrationLabelRequest,type UndoRequest} from '@sortfm/contracts';
import {invalidResponse} from './errors';
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Preference persistence only. D commits revisions/outbox atomically; no provider port. */
export class CalibrationService {
 constructor(private readonly store:CalibrationStore,private readonly options:{now?:()=>number;feedback?:{kick():void}}={}){}
 private timestamp(){return new Date((this.options.now??Date.now)()).toISOString();}
 private kick(){try{this.options.feedback?.kick();}catch{/* Durable outbox polling owns recovery even if the optimization fails. */}}
 async label(userId:string,input:CalibrationLabelRequest){
  IdSchema.parse(userId);const request=CalibrationLabelRequestSchema.parse(input);
  // Do not preflight membership/history: identical retries must resolve before stale
  // eligibility checks, including after a later Undo or cleanup supersedes the label.
  const result=CalibrationLabelResultSchema.safeParse(await this.store.createCalibrationLabel({userId,labelId:crypto.randomUUID(),request,requestFingerprint:fingerprint(request),createdAt:this.timestamp()}));
  if(!result.success||result.data.trackId!==request.trackId||result.data.exposureId!==request.exposureId
   ||result.data.idempotencyKey!==request.idempotencyKey||result.data.submittedLabel!==request.label)throw invalidResponse();
  this.kick();return result.data;
 }
 async undo(userId:string,labelId:string,input:UndoRequest){
  IdSchema.parse(userId);UuidSchema.parse(labelId);const request=UndoRequestSchema.parse(input);
  const result=CalibrationLabelResultSchema.safeParse(await this.store.undoCalibrationLabel({userId,commandId:crypto.randomUUID(),labelId,request,requestFingerprint:fingerprint({labelId,...request}),createdAt:this.timestamp()}));
  if(!result.success||result.data.labelId!==labelId||result.data.state==='active')throw invalidResponse();
  this.kick();return result.data;
 }
 async history(userId:string){
  IdSchema.parse(userId);const result=CalibrationHistorySchema.safeParse(await this.store.calibrationHistory(userId));
  if(!result.success)throw invalidResponse();return result.data;
 }
}
