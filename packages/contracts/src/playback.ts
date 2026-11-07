import {z} from 'zod';
import {ErrorEnvelopeSchema,IdSchema,SpotifyTrackUriSchema,TimestampSchema} from './schemas';

/** The sole browser credential exception. Never add library or control scopes. */
export const PLAYBACK_SDK_SCOPES=['streaming','user-read-email','user-read-private'] as const;
export const PlaybackSdkScopeSchema=z.enum(PLAYBACK_SDK_SCOPES);
export const PlaybackSdkScopesSchema=z.array(PlaybackSdkScopeSchema).length(3)
 .refine(scopes=>new Set(scopes).size===3,'The SDK grant must contain exactly the three SDK scopes');
/** Server-only: private profile scope permits same-owner /me verification, never email/library access. */
export const PLAYBACK_CONTROL_SCOPES=['user-read-playback-state','user-modify-playback-state','user-read-private'] as const;
export const PlaybackControlScopeSchema=z.enum(PLAYBACK_CONTROL_SCOPES);
export const PlaybackControlScopesSchema=z.array(PlaybackControlScopeSchema).length(3)
 .refine(scopes=>new Set(scopes).size===3,'The control grant must contain exactly the three control scopes');
export const PlaybackReturnToSchema=z.enum(['review','calibration']);
export const PlaybackEmptyRequestSchema=z.strictObject({});
export const PlaybackConnectRequestSchema=z.strictObject({returnTo:PlaybackReturnToSchema});
export const PlaybackConnectResponseSchema=z.strictObject({authorizationUrl:z.url().refine(value=>{
 const url=new URL(value);
 return url.protocol==='https:'&&url.hostname==='accounts.spotify.com'&&!url.port&&!url.username&&!url.password
  &&['/authorize','/authorize/'].includes(url.pathname)&&!url.hash
  &&url.searchParams.get('response_type')==='code'&&url.searchParams.getAll('response_type').length===1;
},'Playback authorization must use the Spotify authorization-code endpoint')});
/** Grant readiness only. Does not assert a connected device or audible playback. */
export const PlaybackConnectionStatusSchema=z.strictObject({
 status:z.enum(['ready','reconnect_required','premium_required','unavailable']),
 sdkReady:z.boolean(),controlReady:z.boolean(),reason:z.string().min(1).nullable(),
}).superRefine((value,ctx)=>{
 if(value.status==='ready'&&(!value.sdkReady||!value.controlReady||value.reason!==null))
  ctx.addIssue({code:'custom',message:'Ready requires both grants and no blocking reason'});
 if(value.status!=='ready'&&value.reason===null)ctx.addIssue({code:'custom',message:'Unavailable playback requires an explanation'});
 if(value.status==='reconnect_required'&&value.sdkReady&&value.controlReady)
  ctx.addIssue({code:'custom',message:'Reconnect requires an unavailable grant'});
});
/** Secrets belong only here; the response is owner-only, no-store and memory-only. */
export const PlaybackSdkTokenSchema=z.strictObject({
 ownerId:IdSchema,accessToken:z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/),
 tokenType:z.literal('Bearer'),expiresAt:TimestampSchema,scopes:PlaybackSdkScopesSchema,
});
export const PlaybackDeviceIdSchema=z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/);
export const PlaybackPlayRequestSchema=z.strictObject({trackUri:SpotifyTrackUriSchema,deviceId:PlaybackDeviceIdSchema});
export const PlaybackTransferRequestSchema=z.strictObject({deviceId:PlaybackDeviceIdSchema});
export const PlaybackErrorCodeSchema=z.enum([
 'PLAYBACK_PREMIUM_REQUIRED','PLAYBACK_RECONNECT_REQUIRED','PLAYBACK_UNAVAILABLE','PLAYBACK_SCOPE_REJECTED',
 'PLAYBACK_DEVICE_UNAVAILABLE','PLAYBACK_DEVICE_RESTRICTED','PLAYBACK_TRACK_UNAVAILABLE',
 'PLAYBACK_RATE_LIMITED','PLAYBACK_OUTCOME_UNKNOWN',
]);
/** Common auth/validation errors still use ErrorEnvelope; these codes describe playback failures. */
export const PlaybackErrorEnvelopeSchema=ErrorEnvelopeSchema.extend({code:PlaybackErrorCodeSchema});
export type PlaybackSdkScope=z.infer<typeof PlaybackSdkScopeSchema>;
export type PlaybackControlScope=z.infer<typeof PlaybackControlScopeSchema>;
export type PlaybackReturnTo=z.infer<typeof PlaybackReturnToSchema>;
export type PlaybackConnectRequest=z.infer<typeof PlaybackConnectRequestSchema>;
export type PlaybackConnectResponse=z.infer<typeof PlaybackConnectResponseSchema>;
export type PlaybackConnectionStatus=z.infer<typeof PlaybackConnectionStatusSchema>;
export type PlaybackSdkToken=z.infer<typeof PlaybackSdkTokenSchema>;
export type PlaybackPlayRequest=z.infer<typeof PlaybackPlayRequestSchema>;
export type PlaybackTransferRequest=z.infer<typeof PlaybackTransferRequestSchema>;
export type PlaybackErrorCode=z.infer<typeof PlaybackErrorCodeSchema>;
export type PlaybackErrorEnvelope=z.infer<typeof PlaybackErrorEnvelopeSchema>;
