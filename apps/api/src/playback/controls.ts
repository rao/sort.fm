import {z} from 'zod';
import {PlaybackPlayRequestSchema,PlaybackTransferRequestSchema,PlayerStatusSchema,SpotifyTrackUriSchema,TrackCardSchema,type PlaybackGrant,type PlaybackPlayRequest,type PlaybackTransferRequest,type TrackCard} from '@sortfm/contracts';
import {PlaybackService} from './service';
import {PlaybackError} from './errors';

/** Owner-filtered current library lookup, supplied by runtime composition. */
export interface PlaybackLibraryPort {track(ownerId:string,trackId:string):Promise<TrackCard|null>}
const deviceSchema=z.object({id:z.string().nullable(),is_restricted:z.boolean()});
export class PlaybackControls {
 constructor(private readonly service:PlaybackService,private readonly library:PlaybackLibraryPort){}
 private async use<T>(raw:string|undefined,work:(token:string,grant:PlaybackGrant)=>Promise<T>):Promise<T>{
  const {token,grant}=await this.service.credential(raw,'control');
  try{return await work(token,grant);}catch(error){
   if(error instanceof PlaybackError&&error.code==='PLAYBACK_RECONNECT_REQUIRED')await this.service.rejectControl(grant);
   throw error;
  }
 }
 private async device(token:string,id:string){
  const result=z.object({devices:z.array(deviceSchema)}).safeParse(await this.service.transport.api('/me/player/devices',token));
  if(!result.success)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
  const device=result.data.devices.find(device=>device.id===id);
  if(!device)throw new PlaybackError('PLAYBACK_DEVICE_UNAVAILABLE');
  if(device.is_restricted)throw new PlaybackError('PLAYBACK_DEVICE_RESTRICTED');
 }
 async play(raw:string|undefined,input:PlaybackPlayRequest){
  const request=PlaybackPlayRequestSchema.parse(input);
  return this.use(raw,async(token,grant)=>{
   const track=TrackCardSchema.safeParse(await this.library.track(grant.ownerId,request.trackUri.slice('spotify:track:'.length)));
   if(!track.success||track.data.source!=='spotify'||!track.data.isPlayable||track.data.spotifyUri!==request.trackUri)throw new PlaybackError('PLAYBACK_TRACK_UNAVAILABLE');
   await this.device(token,request.deviceId);await this.service.assertCurrent(raw,grant);
   await this.service.transport.api(`/me/player/play?device_id=${encodeURIComponent(request.deviceId)}`,token,{method:'PUT',body:{uris:[request.trackUri]}});
   return {ok:true} as const;
  });
 }
 async transfer(raw:string|undefined,input:PlaybackTransferRequest){
  const request=PlaybackTransferRequestSchema.parse(input);
  return this.use(raw,async(token,grant)=>{
   await this.device(token,request.deviceId);await this.service.assertCurrent(raw,grant);
   await this.service.transport.api('/me/player',token,{method:'PUT',body:{device_ids:[request.deviceId],play:false}});
   return {ok:true} as const;
  });
 }
 async status(raw?:string){
  return this.use(raw,async(token,grant)=>{
   const body=await this.service.transport.api('/me/player',token);await this.service.assertCurrent(raw,grant);
   if(body===null)return {available:false,deviceId:null,isPlaying:false,trackUri:null,reason:'No active playback device.'};
   const parsed=z.object({device:deviceSchema.nullable(),is_playing:z.boolean(),item:z.object({uri:z.string().optional()}).nullable()}).safeParse(body);
   if(!parsed.success)throw new PlaybackError('PLAYBACK_UNAVAILABLE');
   const {device,is_playing,item}=parsed.data,available=Boolean(device?.id&&!device.is_restricted),uri=SpotifyTrackUriSchema.safeParse(item?.uri);
   return PlayerStatusSchema.parse({available,deviceId:device?.id??null,isPlaying:is_playing,trackUri:uri.success?uri.data:null,
    reason:available?null:device?.is_restricted?'Spotify does not allow control of this device.':'No active playback device.'});
  });
 }
}
