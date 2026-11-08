import {createHash} from 'node:crypto';import {z} from 'zod';
import {IdSchema,SpotifyTrackIdSchema} from '@sortfm/contracts';
import {PersistenceError,type Transaction} from './client';
export type ReviewExclusionManifest={ownerId:string;pilotSchema:string;sortedTrackIds:string[];sha256:string;allowSpotifyMutations?:boolean};
export type ReviewExclusionPolicy=Readonly<{ownerId:string;pilotSchema:string;sha256:string;allowSpotifyMutations:boolean;assertOwner(userId:string):void;denies(userId:string,trackId:string):boolean;assertTrack(userId:string,trackId:string):void}>;
const manifestSchema=z.strictObject({ownerId:IdSchema,pilotSchema:z.string().regex(/^pilot_c2_[a-f0-9]{24}$/),sortedTrackIds:z.array(SpotifyTrackIdSchema).max(100000),sha256:z.string().regex(/^[a-f0-9]{64}$/),allowSpotifyMutations:z.boolean().optional()});
const fail=(code:string):never=>{throw new PersistenceError(code);};
/** Compact JSON with alphabetically ordered keys. Absent mutation opt-in retains
 * the original digest; enabling it requires a separately approved new digest. */
export function reviewExclusionManifestDigest(v:Omit<ReviewExclusionManifest,'sha256'>){return createHash('sha256').update(JSON.stringify({...(v.allowSpotifyMutations===undefined?{}:{allowSpotifyMutations:v.allowSpotifyMutations}),ownerId:v.ownerId,pilotSchema:v.pilotSchema,sortedTrackIds:v.sortedTrackIds})).digest('hex');}
export function createReviewExclusionPolicy(schema:string,input:ReviewExclusionManifest):ReviewExclusionPolicy{
 const parsed=manifestSchema.safeParse(input);if(!parsed.success)return fail('INVALID_REVIEW_EXCLUSIONS');const v=parsed.data;
 if(v.pilotSchema!==schema||v.sortedTrackIds.some((id,i)=>i>0&&id<=v.sortedTrackIds[i-1]!)||reviewExclusionManifestDigest(v)!==v.sha256)fail('INVALID_REVIEW_EXCLUSIONS');
 const denied=new Set(v.sortedTrackIds),assertOwner=(userId:string)=>{if(userId!==v.ownerId)fail('REVIEW_OWNER_MISMATCH');};
 return Object.freeze({ownerId:v.ownerId,pilotSchema:v.pilotSchema,sha256:v.sha256,allowSpotifyMutations:v.allowSpotifyMutations===true,assertOwner,denies(userId:string,trackId:string){assertOwner(userId);return denied.has(trackId);},assertTrack(userId:string,trackId:string){assertOwner(userId);if(denied.has(trackId))fail('REVIEW_TRACK_EXCLUDED');}});
}
/** Membership is a persisted publication/binding relationship, never a timestamp.
 * Consumed/closed publications still authorize exact command replay and Undo. */
export async function assertPublishedReviewExposure(tx:Transaction,policy:ReviewExclusionPolicy|undefined,userId:string,exposureId:string,trackId?:string){
 if(!policy)return;policy.assertOwner(userId);if(trackId!==undefined)policy.assertTrack(userId,trackId);
 const [row]=await tx`SELECT e.payload,e.track_id FROM exposures e
 JOIN policy_exposure_bindings b ON b.user_id=e.user_id AND b.exposure_id=e.exposure_id AND b.track_id=e.track_id
 JOIN policy_selection_intents i ON i.user_id=b.user_id AND i.request_id=b.request_id
 WHERE e.user_id=${userId} AND e.exposure_id=${exposureId} AND e.purpose='review' AND b.published
 AND i.publication IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(i.publication->'items') published(item) WHERE published.item=e.payload)
 AND e.payload->>'userId'=e.user_id AND e.payload->'exposure'->>'exposureId'=e.exposure_id::text
 AND e.payload->'exposure'->>'trackId'=e.track_id`;
 if(!row||(trackId!==undefined&&row.track_id!==trackId))fail('REVIEW_EXPOSURE_NOT_PUBLISHED');policy.assertTrack(userId,row.track_id);
 return row.payload;
}
export async function assertPilotDecision(tx:Transaction,policy:ReviewExclusionPolicy|undefined,userId:string,decisionId:string){
 if(!policy)return;policy.assertOwner(userId);
 const [d]=await tx`SELECT track_id,exposure_id,request,result FROM review_decisions WHERE user_id=${userId} AND decision_id=${decisionId}`;
 if(!d)fail('DECISION_NOT_FOUND');if(d.result?.action!==d.request.action||d.result?.trackId!==d.track_id||d.result?.exposureId!==d.exposure_id)fail('REVIEW_EXPOSURE_NOT_PUBLISHED');assertPilotAction(policy,userId,d.track_id,d.request.action);
 await assertPublishedReviewExposure(tx,policy,userId,d.exposure_id,d.track_id);
}
export function assertPilotAction(policy:ReviewExclusionPolicy|undefined,userId:string,trackId:string,action:string){if(!policy)return;policy.assertTrack(userId,trackId);if(!(policy.allowSpotifyMutations?['KEEP','ARCHIVE','SKIP','UNLIKE']:['KEEP','SKIP']).includes(action))fail('REVIEW_ACTION_NOT_ALLOWED');}
