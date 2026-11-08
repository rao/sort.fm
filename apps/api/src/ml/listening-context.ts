/** Cached observations only: no provider access, feedback creation, or model updates. */
import {z} from 'zod';
import {ErrorEnvelopeSchema, IdSchema, SpotifyTrackIdSchema, TimestampSchema,
  type ListeningContextSnapshot, type TasteContext} from '@sortfm/contracts';

export interface ListeningContextReader {
  /** Return the owner's detached cached value; unknown permits validation of corrupt JSON. */
  getTasteContext(userId:string):Promise<unknown>;
}
export interface ListeningContextOptions {
  userId:string;now:string;
  /** Read wrapper only: defaults to 1000ms; never retries or uses a late result. */
  cacheReadTimeoutMs?:number;
}
export interface PreparedListeningContext {
  /** Fresh, detached, deduplicated events within the inclusion window; otherwise null. */
  tasteContext:TasteContext|null;
  /** Preserve alongside new exposures, never inside FeatureVector or training inputs. */
  listeningContext:ListeningContextSnapshot;
}
const DAY_MS=86_400_000;
const ContextSchema=z.strictObject({
  userId:IdSchema,fetchedAt:TimestampSchema,source:z.literal('spotify-recently-played'),
  completeHistory:z.literal(false),error:ErrorEnvelopeSchema.nullable(),
  events:z.array(z.strictObject({trackId:SpotifyTrackIdSchema,playedAt:TimestampSchema})).max(50),
});

function emptySnapshot(options:ListeningContextOptions):ListeningContextSnapshot {
  IdSchema.parse(options.userId);
  const asOf=TimestampSchema.parse(options.now);
  return {source:'spotify-recently-played',completeHistory:false,sampleLimit:50,status:'missing',
    asOf,fetchedAt:null,ageMs:null,windowStart:new Date(Date.parse(asOf)-30*DAY_MS).toISOString(),
    cachedEventCount:null,uniqueEventCount:null,windowEventCount:null};
}

/** The 30-day filter does not assert complete history. Absence never means zero listening. */
export function prepareListeningContext(raw:unknown,options:ListeningContextOptions):PreparedListeningContext {
  const listeningContext=emptySnapshot(options);
  const missing=(status:ListeningContextSnapshot['status']):PreparedListeningContext=>{
    listeningContext.status=status;
    return {tasteContext:null,listeningContext};
  };
  if(raw===null||raw===undefined)return missing('missing');
  // Quarantine identity mismatches before retaining any cache metadata or events.
  if(typeof raw==='object'&&!Array.isArray(raw)&&'userId' in raw&&raw.userId!==options.userId)
    return missing('owner_mismatch');
  const parsed=ContextSchema.safeParse(raw);
  if(!parsed.success)return missing('invalid');
  const context=parsed.data,asOf=Date.parse(listeningContext.asOf),fetched=Date.parse(context.fetchedAt);
  listeningContext.fetchedAt=context.fetchedAt;
  listeningContext.ageMs=fetched<=asOf?asOf-fetched:null;
  listeningContext.cachedEventCount=context.events.length;
  if(fetched>asOf||context.events.some(event=>Date.parse(event.playedAt)>fetched))return missing('future');
  if(context.error!==null)return missing('provider_error');
  if(asOf-fetched>DAY_MS)return missing('stale');

  const unique=new Map<string,TasteContext['events'][number]>();
  for(const event of context.events){
    const playedAt=new Date(Date.parse(event.playedAt)).toISOString();
    unique.set(`${event.trackId}/${playedAt}`,{trackId:event.trackId,playedAt});
  }
  const start=Date.parse(listeningContext.windowStart);
  const events=[...unique.values()].filter(event=>Date.parse(event.playedAt)>=start)
    .sort((a,b)=>Date.parse(a.playedAt)-Date.parse(b.playedAt)||(a.trackId<b.trackId?-1:a.trackId>b.trackId?1:0));
  listeningContext.status='fresh';
  listeningContext.uniqueEventCount=unique.size;
  listeningContext.windowEventCount=events.length;
  return {tasteContext:{...context,events},listeningContext};
}

/** Exactly one cache read per new batch. Cache failure degrades to missing listening features. */
export async function readCachedTasteContext(reader:ListeningContextReader,options:ListeningContextOptions):Promise<PreparedListeningContext> {
  const frozenOptions={userId:options.userId,now:options.now};
  const listeningContext=emptySnapshot(frozenOptions); // Reject invalid callers before I/O.
  const timeoutMs=options.cacheReadTimeoutMs===undefined?1000:options.cacheReadTimeoutMs;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new RangeError('Invalid listening cache deadline');
  const failure=():PreparedListeningContext=>({tasteContext:null,listeningContext:{...listeningContext,status:'read_error'}});
  const deadline=performance.now()+timeoutMs;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let raw:unknown;
  try{
    raw=await Promise.race([
      reader.getTasteContext(frozenOptions.userId),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Listening cache deadline exceeded')),timeoutMs);}),
    ]);
    if(performance.now()>deadline)return failure();
  }catch{return failure();}
  finally{clearTimeout(timer);}
  return prepareListeningContext(raw,frozenOptions);
}
