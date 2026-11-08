import {z} from 'zod';
import {IdSchema,SpotifyTrackIdSchema} from './schemas';

export const CONSTELLATION_AUDIO_KEYS=['energy','danceability','happiness','acousticness','instrumentalness','liveness','speechiness','tempo_bpm','loudness_db'] as const;
const unit=z.number().finite().min(0).max(1).nullable().optional();
export const TasteConstellationAudioSchema=z.strictObject({
 energy:unit,danceability:unit,happiness:unit,acousticness:unit,instrumentalness:unit,liveness:unit,speechiness:unit,
 tempo_bpm:z.number().finite().positive().max(400).nullable().optional(),
 loudness_db:z.number().finite().min(-100).max(10).nullable().optional(),
});
export const TasteConstellationPredictionSchema=z.strictObject({
 modelVersion:z.string().min(1).max(128),scoredAt:z.iso.datetime({offset:true}),
 removalProbability:z.number().finite().min(0).max(1),calibrated:z.boolean(),
 explanations:z.array(z.strictObject({feature:z.string().min(1).max(100),contribution:z.number().finite().nullable(),description:z.string().max(600)})).max(50),
});
export const TasteConstellationTrackSchema=z.strictObject({
 id:z.string().min(1).max(128),title:z.string().min(1).max(200),artist:z.string().min(1).max(300),
 imageUrl:z.url({protocol:/^https$/}).nullable(),label:z.enum(['keep','remove']).nullable(),
 audio:TasteConstellationAudioSchema,prediction:TasteConstellationPredictionSchema.nullable(),
});
/** Privacy is a server guarantee: validation alone cannot establish exclusions. */
export const TasteConstellationSchema=z.strictObject({
 schema:z.literal('sortfm.constellation.v1'),mode:z.enum(['live','synthetic']),privacy:z.literal('evaluation-excluded'),
 generatedAt:z.iso.datetime({offset:true}),modelVersion:z.string().min(1).max(128).nullable(),tracks:z.array(TasteConstellationTrackSchema).max(5000),
}).superRefine((data,ctx)=>{
 if(new Set(data.tracks.map(t=>t.id)).size!==data.tracks.length||data.tracks.some(t=>data.mode==='live'
  ?!/^[a-zA-Z0-9]{22}$/.test(t.id)
  :!/^demo:constellation:\d+$/.test(t.id)||t.prediction!==null||t.imageUrl!==null)
  ||(data.mode==='synthetic'&&data.modelVersion!==null))ctx.addIssue({code:'custom',message:'Invalid constellation provenance or identity'});
});
export type TasteConstellation=z.infer<typeof TasteConstellationSchema>;
export const TasteConstellationLiveSchema=TasteConstellationSchema.safeExtend({mode:z.literal('live')});
export type TasteConstellationLive=z.infer<typeof TasteConstellationLiveSchema>;
export type TasteConstellationTrack=z.infer<typeof TasteConstellationTrackSchema>;
export type TasteConstellationAudio=z.infer<typeof TasteConstellationAudioSchema>;

/** Server-only, already privacy-filtered snapshot. Never serialize this envelope.
 * Implementations must exclude permanent evaluation/monitoring identities and
 * pending work BEFORE the fixed 5000 bound, and fail closed if that is unprovable.
 * Labels are only effective explicit eligible training labels; cached audio is
 * observed, never imputed. No scoring, provider or write capabilities belong here.
 */
export const ConstellationProjectionSchema=z.strictObject({
 userId:IdSchema,
 tracks:z.array(TasteConstellationTrackSchema.omit({prediction:true}).extend({id:SpotifyTrackIdSchema})).max(5000),
}).refine(data=>new Set(data.tracks.map(t=>t.id)).size===data.tracks.length,{message:'Duplicate constellation identity'});
export type ConstellationProjection=z.infer<typeof ConstellationProjectionSchema>;
export interface ConstellationReadPort {constellation(userId:string):Promise<ConstellationProjection>}
