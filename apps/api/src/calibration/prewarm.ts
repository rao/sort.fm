/** Server-only priority export. No provider, database, scoring, fitting or file I/O. */
import {z} from 'zod';
import {IdSchema,SpotifyTrackIdSchema,TimestampSchema,UuidSchema,TrackCardSchema,SavedTrackInputSchema,MutationStatusSchema,type CalibrationLibraryRow,type ExposurePurpose} from '@sortfm/contracts';
import {selectDiverseCalibrationRows} from './selection';
export const PREWARM_RECENT_EXPOSURE_LIMIT=250;
export const PREWARM_LIBRARY_LIMIT=10000;
export interface RecentPrewarmExposure {
 exposureId:string;trackId:string;purpose:ExposurePurpose;servedAt:string;position:number;consumed:boolean;
}
export interface PrewarmPrioritySnapshot {
 userId:string;
 library:CalibrationLibraryRow[];
 /** Current imported, playable, saved/deferred tracks, excluding active calibration
  * labels, settled cleanup and ALL unresolved review/Undo work (even expired leases).
  * Must come from authoritative eligibility, not exposure-time or UI state. */
 eligibleTrackIds:string[];
 recentExposures:RecentPrewarmExposure[];
}
export interface PrewarmPriorityPort {
 /** One consistent owner-scoped read. Return newest batches first, each in position
  * order, bounded before returning. No exposure creation or other mutation. */
 readPrewarmSnapshot(userId:string,query:{since:string;limit:number}):Promise<PrewarmPrioritySnapshot>;
}
export interface PrewarmPriorityOptions {now?:number;limit?:number;recentWindowMs?:number}
const optionsSchema=z.strictObject({now:z.number().int().min(86400000).max(8640000000000000),limit:z.number().int().min(1).max(25),recentWindowMs:z.number().int().min(1).max(86400000)});
const recentSchema=z.strictObject({exposureId:UuidSchema,trackId:SpotifyTrackIdSchema,purpose:z.enum(['review','calibration']),servedAt:TimestampSchema,position:z.number().int().nonnegative(),consumed:z.boolean()});
function options(input:PrewarmPriorityOptions){return optionsSchema.parse({now:Date.now(),limit:25,recentWindowMs:30*60*1000,...input});}
const invalid=():never=>{throw new Error('INVALID_PREWARM_SNAPSHOT');};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Keeps recently issued batch order; never changes review ranking or requests ML. */
export function selectPrewarmTrackIds(userId:string,snapshot:PrewarmPrioritySnapshot,input:PrewarmPriorityOptions={}):string[]{
 IdSchema.parse(userId);const config=options(input);
 if(snapshot.userId!==userId||snapshot.library.length>PREWARM_LIBRARY_LIMIT||snapshot.eligibleTrackIds.length>PREWARM_LIBRARY_LIMIT||snapshot.recentExposures.length>PREWARM_RECENT_EXPOSURE_LIMIT)invalid();
 const library=new Map<string,CalibrationLibraryRow>();
 for(const row of snapshot.library){
  TrackCardSchema.parse(row.track);SavedTrackInputSchema.shape.currentStatus.parse(row.currentStatus);
  if(row.currentDecision)MutationStatusSchema.parse(row.currentDecision.status);
  if(library.has(row.track.trackId))invalid();library.set(row.track.trackId,row);
 }
 const eligible=new Set<string>();
 for(const id of snapshot.eligibleTrackIds){
  SpotifyTrackIdSchema.parse(id);if(eligible.has(id)||!library.has(id))invalid();eligible.add(id);
 }
 const rows=snapshot.library.filter(row=>eligible.has(row.track.trackId)&&row.track.source==='spotify'&&row.track.isPlayable
  &&['saved','deferred'].includes(row.currentStatus)&&(!row.currentDecision||['UNDONE','FAILED_TERMINAL'].includes(row.currentDecision.status)));
 const usable=new Set(rows.map(row=>row.track.trackId)),exposureIds=new Set<string>();
 const recent=snapshot.recentExposures.map(item=>{
  const parsed=recentSchema.parse(item);if(exposureIds.has(parsed.exposureId))invalid();exposureIds.add(parsed.exposureId);return parsed;
 }).filter(item=>!item.consumed&&usable.has(item.trackId)&&Date.parse(item.servedAt)>=config.now-config.recentWindowMs&&Date.parse(item.servedAt)<=config.now)
 .sort((a,b)=>Date.parse(b.servedAt)-Date.parse(a.servedAt)||compare(a.purpose,b.purpose)||a.position-b.position||compare(a.exposureId,b.exposureId));
 const selected=new Set<string>();
 for(const item of recent){selected.add(item.trackId);if(selected.size===config.limit)return [...selected];}
 // Preserve the full eligible pool's existing diversity order. Do not rebucket after
 // removing recent IDs; at most `limit` duplicates means 2*limit suffices to fill.
 for(const row of selectDiverseCalibrationRows(rows,userId,config.limit+selected.size)){
  selected.add(row.track.trackId);if(selected.size===config.limit)break;
 }
 return [...selected];
}
/** Root may serialize the returned string[] to D's private --priority-file JSON. */
export async function readPrewarmPriority(port:PrewarmPriorityPort,userId:string,input:PrewarmPriorityOptions={}):Promise<string[]>{
 IdSchema.parse(userId);const config=options(input);
 const snapshot=await port.readPrewarmSnapshot(userId,{since:new Date(config.now-config.recentWindowMs).toISOString(),limit:PREWARM_RECENT_EXPOSURE_LIMIT});
 return selectPrewarmTrackIds(userId,snapshot,config);
}
