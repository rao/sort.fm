import {AudioFeaturesInputSchema, FEATURE_VERSION, type AudioFeaturesInput, type FeatureVector} from '@sortfm/contracts';
const percentages = ['energy','danceability','happiness','acousticness','instrumentalness','liveness','speechiness'] as const;
function number(value: unknown): number | null {
 if (typeof value !== 'number' && typeof value !== 'string') return null;
 if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return null;
 const n=Number(value); return Number.isFinite(n) ? n : null;
}
function range(value: unknown,min:number,max:number) { const n=number(value); return n!==null && n>=min && n<=max ? n : null; }
export function normalizeSoundNet(raw: unknown, trackId: string, rights: {permittedForTraining:boolean; rightsBasis?:string}={permittedForTraining:false}, fetchedAt=new Date().toISOString()): AudioFeaturesInput {
 if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('INVALID_PROVIDER_BODY');
 const body=raw as Record<string,unknown>;
 if (body.error || body.success===false) throw new Error('PROVIDER_ERROR_BODY');
 for(const key of ['spotify_id','spotifyId','spotifyTrackId','trackId']) if(body[key]!==undefined && body[key]!==trackId) throw new Error('TRACK_MISMATCH');
 const values: FeatureVector['values']={};
 for(const key of percentages) {const n=range(body[key],0,100);values[key]=n===null?null:n/100;}
 const popularity=range(body.popularity,0,100); values.soundnet_popularity=popularity===null?null:popularity/100;
 values.tempo_bpm=range(body.tempo,Number.MIN_VALUE,400);
 values.loudness_db=range(typeof body.loudness==='string'?body.loudness.replace(/\s*dB$/i,'').trim():body.loudness,-100,10);
 // Only documented mm:ss format is interpreted; an unqualified number has unknown units.
 const duration=typeof body.duration==='string'?body.duration.match(/^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/):null;
 values.duration_ms=duration?Number(duration[1])*60000+Number(duration[2])*1000+Number((duration[3]??'').padEnd(3,'0')):null;
 const keys:Record<string,number>={'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'F':5,'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11};
 const key=typeof body.key==='string'?keys[body.key.trim().toUpperCase().replace('♯','#').replace('♭','B')]:undefined;
 values.key_sin=key===undefined?null:Math.sin(2*Math.PI*key/12);values.key_cos=key===undefined?null:Math.cos(2*Math.PI*key/12);
 const mode=typeof body.mode==='string'?body.mode.trim().toLowerCase():body.mode;
 values.mode_major=mode==='major'||mode===1?1:mode==='minor'||mode===0?0:null;
 if (!Object.values(values).some(v=>v!==null)) throw new Error('NO_USABLE_FEATURES');
 const dataQuality: AudioFeaturesInput['dataQuality']={normalizer:'soundnet.v1'};
 for (const [key,value] of Object.entries(values)) dataQuality[`${key}_missing`]=value===null;
 return AudioFeaturesInputSchema.parse({trackId,provider:'soundnet',raw,normalized:{featureVersion:FEATURE_VERSION,values,provenance:'soundnet',...rights},fetchedAt,status:'success',dataQuality});
}
