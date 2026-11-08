import {createHash} from 'node:crypto';
import type {FeatureVector,Prediction,TrackCard,CalibrationBatchSelection} from '@sortfm/contracts';
export const BATCH_ALGORITHM='calibration-batch2:v1';
// Fixed selection heuristic, declared before any Batch2 outcomes are observed.
export const MIN_AMBIGUITY_ENTROPY=.8;
export type FrozenCandidate={track:TrackCard;features:FeatureVector;prediction:Prediction};
export type BatchSelection=CalibrationBatchSelection;
const keys=['saved_age_days','energy','danceability','happiness','tempo_bpm','acousticness','instrumentalness','liveness','speechiness','loudness_db','duration_ms','release_age_years'] as const;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const artist=(c:FrozenCandidate)=>{const a=c.track.artists[0]!;return a.id??a.name.normalize('NFKC').trim().toLowerCase();};
function hash(seed:number,group:string,id:string){return createHash('sha256').update(JSON.stringify([BATCH_ALGORITHM,seed,group,id])).digest('hex');}
function entropy(p:number){return p===0||p===1?0:-(p*Math.log2(p)+(1-p)*Math.log2(1-p));}
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
/** Input must be the store's never-reviewed pool. Scores are one frozen C1 response. */
export function selectCalibrationBatch(input:readonly FrozenCandidate[],seed:number){
 if(!Number.isSafeInteger(seed))throw Error('INVALID_BATCH_SEED');
 const pool=[...input].sort((a,b)=>cmp(a.track.trackId,b.track.trackId));
 if(pool.length<70||new Set(pool.map(c=>c.track.trackId)).size!==pool.length)throw Error('INSUFFICIENT_UNIQUE_BATCH_CANDIDATES');
 if(pool.some(c=>!['logistic','sgd_logistic'].includes(c.prediction.modelKind)||c.prediction.removalProbability===null))throw Error('BATCH_REQUIRES_LEARNED_PROBABILITIES');
 const make=(c:FrozenCandidate,group:BatchSelection['group'],score:number|null,kind:BatchSelection['scoreKind']):BatchSelection=>({trackId:c.track.trackId,group,assignment:group==='A'?'sealed_evaluation':'train',samplingMethod:`${BATCH_ALGORITHM}:${group==='A'?'random':group==='B'?'diverse':'uncertain'}`,selectionScore:score,scoreKind:kind,selectionProbability:group==='A'?25/pool.length:null});
 const random=[...pool].sort((a,b)=>cmp(hash(seed,'A',a.track.trackId),hash(seed,'A',b.track.trackId))).map(c=>make(c,'A',null,'seeded_random'));
 const used=new Set(random.slice(0,25).map(c=>c.trackId));
 const normalized=vectors(pool),distances=pool.map(()=>1),counts=new Map<string,number>();
 const ageOrder=pool.map((_,i)=>i).sort((a,b)=>(pool[a]!.features.values.saved_age_days??0)-(pool[b]!.features.values.saved_age_days??0)||cmp(pool[a]!.track.trackId,pool[b]!.track.trackId));
 const quartile=new Map(ageOrder.map((index,rank)=>[index,Math.min(3,Math.floor(rank*4/pool.length))]));
 const ties=pool.map(c=>hash(seed,'B',c.track.trackId)),remaining=new Set(pool.map((_,i)=>i).filter(i=>!used.has(pool[i]!.track.trackId)));
 const diverse:BatchSelection[]=[];
 while(remaining.size){
  const desired=diverse.length%4;const inQuartile=[...remaining].filter(i=>quartile.get(i)===desired);const candidates=inQuartile.length?inQuartile:[...remaining];
  // Artist novelty precedes musical distance; relax only when a cohort runs out.
  let chosen=candidates[0]!;
  for(const i of candidates){const ca=counts.get(artist(pool[i]!))??0,cb=counts.get(artist(pool[chosen]!))??0;
   if(ca<cb||(ca===cb&&(distances[i]!>distances[chosen]!||(distances[i]===distances[chosen]&&cmp(ties[i]!,ties[chosen]!)<0))))chosen=i;
  }
  const c=pool[chosen]!;diverse.push(make(c,'B',Math.sqrt(distances[chosen]!),'coverage_distance'));remaining.delete(chosen);counts.set(artist(c),(counts.get(artist(c))??0)+1);
  for(const i of remaining){let d=0;for(let k=0;k<keys.length;k++)d+=(normalized[i]![k]!-normalized[chosen]![k]!)**2;distances[i]=Math.min(distances[i]!,d/keys.length);}
 }
 for(const c of diverse.slice(0,25))used.add(c.trackId);
 const uncertainPool=pool.filter(c=>!used.has(c.track.trackId)&&entropy(c.prediction.removalProbability!)>=MIN_AMBIGUITY_ENTROPY).sort((a,b)=>entropy(b.prediction.removalProbability!)-entropy(a.prediction.removalProbability!)||cmp(hash(seed,'C',a.track.trackId),hash(seed,'C',b.track.trackId)));
 if(uncertainPool.length<20)throw Error('INSUFFICIENT_AMBIGUOUS_CANDIDATES');
 const uncertain:BatchSelection[]=[];counts.clear();
 while(uncertainPool.length){
  let index=0;for(let i=1;i<uncertainPool.length;i++)if((counts.get(artist(uncertainPool[i]!))??0)<(counts.get(artist(uncertainPool[index]!))??0))index=i;
  const c=uncertainPool.splice(index,1)[0]!;counts.set(artist(c),(counts.get(artist(c))??0)+1);
  uncertain.push(make(c,'C',entropy(c.prediction.removalProbability!),'entropy_heuristic'));
 }
 // Interleave groups so stopping early does not label only the evaluation cohort.
 const selected:BatchSelection[]=[];for(let i=0;i<25;i++){selected.push(random[i]!,diverse[i]!);if(i<20)selected.push(uncertain[i]!);}
 return {selected,pools:{A:random,B:diverse,C:uncertain}};
}
