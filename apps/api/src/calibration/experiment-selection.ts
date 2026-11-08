import {createHash} from 'node:crypto';
import type {CalibrationExperimentDraft} from '@sortfm/contracts';
export const EXPERIMENT_ALGORITHM='calibration-batch3:sha256-fisher-yates-diverse:v1';
type FrozenCandidate=CalibrationExperimentDraft['candidates'][number];
type Selection=CalibrationExperimentDraft['selected'][number];
const keys=['saved_age_days','energy','danceability','happiness','tempo_bpm','acousticness','instrumentalness','liveness','speechiness','loudness_db','duration_ms','release_age_years'] as const;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const artist=(c:FrozenCandidate)=>{const a=c.track.artists[0]!;return a.id??a.name.normalize('NFKC').trim().toLowerCase();};
function hash(seed:number,group:string,id:string){return createHash('sha256').update(JSON.stringify([EXPERIMENT_ALGORITHM,seed,group,id])).digest('hex');}
/** Label-free quantile scaling. Missing values are neutral, never a missingness distance. */
function vectors(pool:FrozenCandidate[]){
 const columns=keys.map(key=>pool.map(c=>c.features.values[key]).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b));
 return pool.map(c=>keys.map((key,j)=>{
  const values=columns[j]!,value=c.features.values[key];
  if(values.length<pool.length/2||typeof value!=='number'||values[0]===values.at(-1))return .5;
  let low=0,high=values.length;while(low<high){const mid=(low+high)>>>1;if(values[mid]!<value)low=mid+1;else high=mid;}
  const first=low;high=values.length;while(low<high){const mid=(low+high)>>>1;if(values[mid]!<=value)low=mid+1;else high=mid;}
  return (first+low-1)/2/Math.max(1,values.length-1);
 }));
}

/** SHA-256 counter stream, BE uint32 words; rejection removes modulo bias.
 * Input is a canonical sorted identity pool and a seed committed before capture.
 * Full Fisher-Yates shuffle, then take forty: no score-dependent A selection.
 */
function randomIndex(seed:number) {
 let counter=0,offset=32,block=Buffer.alloc(32);
 return (bound:number)=>{
  const ceiling=Math.floor(0x100000000/bound)*bound;
  for(;;){
   if(offset===32){block=createHash('sha256').update(JSON.stringify([EXPERIMENT_ALGORITHM,seed,'A',counter++])).digest();offset=0;}
   const value=block.readUInt32BE(offset);offset+=4;
   if(value<ceiling)return value%bound;
  }
 };
}
export function selectCalibrationExperiment(input:readonly FrozenCandidate[],seed:number):Pick<CalibrationExperimentDraft,'selected'|'replacementPool'> {
 if(!Number.isInteger(seed)||seed<0||seed>2147483647)throw Error('INVALID_EXPERIMENT_SEED');
 const pool=[...input].sort((a,b)=>cmp(a.track.trackId,b.track.trackId));
 if(pool.length<60||pool.length>10000||new Set(pool.map(c=>c.track.trackId)).size!==pool.length)throw Error('INVALID_EXPERIMENT_POOL');
 const make=(c:FrozenCandidate,group:'A'|'B',score:number|null):Selection=>({trackId:c.track.trackId,group,assignment:group==='A'?'sealed_evaluation':'train',samplingMethod:`${EXPERIMENT_ALGORITHM}:${group==='A'?'random':'diverse'}`,selectionScore:score,scoreKind:group==='A'?'seeded_random':'coverage_distance',selectionProbability:group==='A'?40/pool.length:null});
 const shuffled=[...pool],draw=randomIndex(seed);
 for(let i=shuffled.length-1;i>0;i--){const j=draw(i+1);[shuffled[i],shuffled[j]]=[shuffled[j]!,shuffled[i]!];}
 const evaluation=shuffled.slice(0,40).map(c=>make(c,'A',null)),used=new Set(evaluation.map(s=>s.trackId));
 const normalized=vectors(pool),distances=pool.map(()=>1),counts=new Map<string,number>();
 const ageOrder=pool.map((_,i)=>i).sort((a,b)=>(pool[a]!.features.values.saved_age_days??0)-(pool[b]!.features.values.saved_age_days??0)||cmp(pool[a]!.track.trackId,pool[b]!.track.trackId));
 const quartile=new Map(ageOrder.map((index,rank)=>[index,Math.min(3,Math.floor(rank*4/pool.length))]));
 const ties=pool.map(c=>hash(seed,'B',c.track.trackId)),remaining=new Set(pool.map((_,i)=>i).filter(i=>!used.has(pool[i]!.track.trackId)));
 const replacementPool:Selection[]=[];
 while(remaining.size){
  const desired=replacementPool.length%4,inQuartile=[...remaining].filter(i=>quartile.get(i)===desired),candidates=inQuartile.length?inQuartile:[...remaining];
  let chosen=candidates[0]!;
  for(const i of candidates){const ca=counts.get(artist(pool[i]!))??0,cb=counts.get(artist(pool[chosen]!))??0;
   if(ca<cb||(ca===cb&&(distances[i]!>distances[chosen]!||(distances[i]===distances[chosen]&&cmp(ties[i]!,ties[chosen]!)<0))))chosen=i;
  }
  const c=pool[chosen]!;replacementPool.push(make(c,'B',Math.sqrt(distances[chosen]!)));remaining.delete(chosen);counts.set(artist(c),(counts.get(artist(c))??0)+1);
  for(const i of remaining){let d=0;for(let k=0;k<keys.length;k++)d+=(normalized[i]![k]!-normalized[chosen]![k]!)**2;distances[i]=Math.min(distances[i]!,d/keys.length);}
 }
 return {selected:[...evaluation,...replacementPool.slice(0,20)],replacementPool};
}
