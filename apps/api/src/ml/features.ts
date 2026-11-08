/** Exposure-time feature assembly. This module never constructs feedback labels. */
import {createHash} from 'node:crypto';
import {
  FEATURE_VERSION, FeatureValuesSchema, FeatureVectorSchema, FitRequestSchema,
  IdSchema, TimestampSchema, TrackCardSchema,
  type FeatureVector, type ReviewResult, type SavedTrackInput, type ScoringCandidate,
  type TasteContext, type TrackCard,
} from '@sortfm/contracts';
import {prepareListeningContext,readCachedTasteContext,type ListeningContextReader,type ListeningContextOptions} from './listening-context';

/** Structural match for D Repository.library(), without a runtime DB dependency. */
export interface MlLibraryRow {
  track: TrackCard;
  currentStatus: SavedTrackInput['currentStatus'];
  audioFeatures: FeatureVector | null;
  currentDecision: ReviewResult | null;
}
export type TrainingPermission = Pick<FeatureVector, 'permittedForTraining' | 'rightsBasis'>;
export interface FeatureAssemblyOptions {
  userId: string;
  /** Freeze once for the entire exposure batch; retry the resulting candidates unchanged. */
  now: string;
  metadataTraining?: TrainingPermission;
  tasteContext?: TasteContext | null;
}
const DAY_MS=86_400_000;
const AUDIO_KEYS=['energy','danceability','happiness','acousticness','instrumentalness','liveness',
  'speechiness','tempo_bpm','loudness_db','key_sin','key_cos','mode_major','soundnet_popularity'] as const;
const AudioHeaderSchema=FeatureVectorSchema.omit({values:true});

function artistKey(track:TrackCard):string {
  const primary=track.artists[0]!;
  return primary.id===null ? `name:${primary.name.normalize('NFKC').trim().toLowerCase()}` : `id:${primary.id}`;
}

function recentCounts(options:FeatureAssemblyOptions):Map<string,number>|null {
  const context=prepareListeningContext(options.tasteContext,{userId:options.userId,now:options.now}).tasteContext;
  if(!context)return null;
  const counts=new Map<string,number>();
  for(const event of context.events)counts.set(event.trackId,(counts.get(event.trackId)??0)+1);
  return counts;
}

export function assembleLibraryCandidates(rows:readonly MlLibraryRow[],options:FeatureAssemblyOptions):ScoringCandidate[] {
  IdSchema.parse(options.userId);
  const asOf=Date.parse(TimestampSchema.parse(options.now));
  const permission=options.metadataTraining??{permittedForTraining:false};
  const tracks=rows.map(row=>TrackCardSchema.parse(row.track));
  if(new Set(tracks.map(track=>track.trackId)).size!==tracks.length)throw new Error('DUPLICATE_TRACK');
  const artistCounts=new Map<string,number>();
  for(const track of tracks)artistCounts.set(artistKey(track),(artistCounts.get(artistKey(track))??0)+1);
  const recent=recentCounts(options);
  return tracks.map((track,index)=>{
    const year=track.releaseDate===null?null:Number(track.releaseDate.slice(0,4));
    const values:FeatureVector['values']={
      saved_age_days:Math.max(0,(asOf-Date.parse(track.originalAddedAt))/DAY_MS),
      release_age_years:year===null?null:Math.max(0,new Date(asOf).getUTCFullYear()-year),
      duration_ms:track.durationMs,
      artist_library_count:artistCounts.get(artistKey(track))!,
    };
    const observedCount=recent?.get(track.trackId);
    if(observedCount!==undefined)values.recent_play_count=observedCount;
    let provenance:FeatureVector['provenance']=track.source==='synthetic'?'synthetic':'spotify';
    const bases=permission.rightsBasis?[`Metadata: ${permission.rightsBasis}`]:[];
    const audio=rows[index]!.audioFeatures;
    if(audio&&typeof audio==='object'){
      const {values:audioValues,...header}=audio;
      const parsed=AudioHeaderSchema.safeParse(header);
      const compatible=parsed.success&&(track.source==='synthetic'
        ? parsed.data.provenance==='synthetic'
        : ['soundnet','licensed','musicae'].includes(parsed.data.provenance));
      if(compatible&&parsed.success&&parsed.data.permittedForTraining&&audioValues&&typeof audioValues==='object'){
        let observed=false;
        for(const key of AUDIO_KEYS){
          if(!Object.hasOwn(audioValues,key))continue;
          const checked=FeatureValuesSchema.shape[key].safeParse(audioValues[key]);
          const value=checked.success?checked.data:null;
          // Each corrupt field is missing; normalized values are never scaled twice.
          Object.assign(values,{[key]:value??null});
          observed ||= value!==null&&value!==undefined;
        }
        if(observed){
          provenance=parsed.data.provenance;
          if(parsed.data.rightsBasis)bases.push(`Audio: ${parsed.data.rightsBasis}`);
        }
      }
    }
    return {trackId:track.trackId,features:FeatureVectorSchema.parse({featureVersion:FEATURE_VERSION,
      values,provenance,permittedForTraining:permission.permittedForTraining,
      ...(bases.length?{rightsBasis:bases.join('; ')}:{})})};
  });
}

/** New exposures only. Persist the returned coverage beside the exact candidate snapshots. */
export async function assembleLibraryCandidatesWithListeningContext(
  rows:readonly MlLibraryRow[],options:Omit<FeatureAssemblyOptions,'tasteContext'>&ListeningContextOptions,reader:ListeningContextReader,
) {
  const frozenOptions={...options,...(options.metadataTraining?{metadataTraining:{...options.metadataTraining}}:{})};
  const {tasteContext,listeningContext}=await readCachedTasteContext(reader,frozenOptions);
  return {candidates:assembleLibraryCandidates(rows,{...frozenOptions,tasteContext}),listeningContext};
}

/** Same compact ASCII-ID tuple/hash rule as Python C1's new-feedback assignment. */
export function feedbackSplit(userId:string,trackId:string,evaluationSeed=42):'train'|'holdout' {
  IdSchema.parse(userId);IdSchema.parse(trackId);FitRequestSchema.shape.evaluationSeed.parse(evaluationSeed);
  const hash=createHash('sha256').update(JSON.stringify([evaluationSeed,userId,trackId])).digest('hex');
  return BigInt(`0x${hash.slice(0,16)}`)%5n===0n?'holdout':'train';
}
