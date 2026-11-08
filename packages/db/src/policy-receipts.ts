import {FitResponseSchema,IdSchema,type FitResponse} from '@sortfm/contracts';import type {Transaction} from './client';import * as p from './policy-core';
export function validateFit(userId:string,value:FitResponse){const r=FitResponseSchema.safeParse(value);if(!r.success||r.data.userId!==userId||!r.data.modelVersion||r.data.metrics.modelVersion!==r.data.modelVersion||r.data.metrics.trainedExamples!==r.data.trainedExamples)return p.fail('POLICY_FIT_RECEIPT_INVALID');return r.data;}
/** Caller holds shared owner lock. No job acknowledgement or provider/model calls. */
export async function recordFit(tx:Transaction,userId:string,value:FitResponse):Promise<boolean>{
 p.parse(IdSchema,userId);const v=validateFit(userId,value);if(!await p.ready(tx))return false;
 const [u]=await tx`SELECT feedback_revision FROM users WHERE id=${userId}`;if(!u||v.feedbackRevision>u.feedback_revision)return false;
 const old=await p.fitReceipt(tx,userId);if(old&&(old.synchronizedFeedbackRevision>v.feedbackRevision||(old.synchronizedFeedbackRevision===v.feedbackRevision&&old.modelVersion!==v.modelVersion)))return false;
 await tx`INSERT INTO policy_fit_receipts(user_id,model_version,feedback_revision) VALUES(${userId},${v.modelVersion},${v.feedbackRevision}) ON CONFLICT(user_id) DO UPDATE SET model_version=excluded.model_version,feedback_revision=excluded.feedback_revision,recorded_at=clock_timestamp()`;return true;
}

/** A newer actual receipt already covers this job; a same-revision model conflict does not. */
export async function recordAcknowledgedFit(tx:Transaction,userId:string,value:FitResponse):Promise<void>{
 if(await recordFit(tx,userId,value)||!await p.ready(tx))return;
 const current=await p.fitReceipt(tx,userId);
 if(current&&current.synchronizedFeedbackRevision>value.feedbackRevision)return;
 p.fail('POLICY_FIT_RECEIPT_CONFLICT');
}
