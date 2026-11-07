import {createHash} from 'node:crypto';
import type {CalibrationLibraryRow} from '@sortfm/contracts';
export const CALIBRATION_SELECTION_POLICY='calibration:metadata-diverse:v1';
const POLICY=CALIBRATION_SELECTION_POLICY;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function artist(row:CalibrationLibraryRow){const a=row.track.artists[0]!;return a.id===null?`name:${a.name.normalize('NFKC').trim().toLowerCase()}`:`id:${a.id}`;}
/** Broad online sampling, not C1's separate sealed offline experiment. No scores or labels. */
export function selectDiverseCalibrationRows(rows:readonly CalibrationLibraryRow[],userId:string,limit:number):CalibrationLibraryRow[]{
 const dated=[...rows].sort((a,b)=>Date.parse(a.track.originalAddedAt)-Date.parse(b.track.originalAddedAt)||compare(a.track.trackId,b.track.trackId));
 const buckets:CalibrationLibraryRow[][]=Array.from({length:Math.min(4,rows.length)},()=>[]);
 for(const [i,row] of dated.entries())buckets[Math.floor(i*buckets.length/dated.length)]!.push(row);
 const hash=new Map(rows.map(r=>[r.track.trackId,createHash('sha256').update(JSON.stringify([POLICY,userId,r.track.trackId])).digest('hex')]));
 for(const bucket of buckets)bucket.sort((a,b)=>compare(hash.get(a.track.trackId)!,hash.get(b.track.trackId)!)||compare(a.track.trackId,b.track.trackId));
 const result:CalibrationLibraryRow[]=[],artistCounts=new Map<string,number>();
 // Round-robin save-age quartiles. Prefer the least represented primary artist
 // inside each cohort, retaining the seeded order for equal counts.
 while(result.length<Math.min(limit,rows.length)){
  for(const bucket of buckets){
   if(!bucket.length)continue;
   let chosen=0;
   for(let i=1;i<bucket.length;i++)if((artistCounts.get(artist(bucket[i]!))??0)<(artistCounts.get(artist(bucket[chosen]!))??0))chosen=i;
   const row=bucket.splice(chosen,1)[0]!;result.push(row);const key=artist(row);artistCounts.set(key,(artistCounts.get(key)??0)+1);
   if(result.length===Math.min(limit,rows.length))break;
  }
 }
 return result;
}
