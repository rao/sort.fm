import {z} from 'zod';
import {IdSchema, SpotifyTrackIdSchema} from '@sortfm/contracts';
import type {AccessCredential} from '../auth/service';
import {SpotifyHttp, type Fetch} from './http';
import {safeError, SpotifyError} from './errors';

export interface MutationAuthorization {
  accessToken(userId:string,rejectedVersion?:string):Promise<AccessCredential>;
  requireScopes(userId:string,scopes:string[]):Promise<void>;
  revoke(userId:string,version:string):Promise<boolean>;
}
export class MutationRequestError extends SpotifyError {
  constructor(code:string,message:string,status:number,retryable:boolean,readonly outcome:'rejected'|'unknown',retryAt:number|null=null) {super(code,message,status,retryable,retryAt);}
}
const invalid=()=>new SpotifyError('SPOTIFY_INVALID_RESPONSE','Spotify returned an invalid response.',502,true);
const id=SpotifyTrackIdSchema;
const playlistSchema=z.object({id,public:z.boolean().nullable(),owner:z.object({id:z.string()}),description:z.string().nullable().optional()});
const pageSchema=z.object({offset:z.number().int().nonnegative(),total:z.number().int().nonnegative(),items:z.array(z.unknown()).max(50)});
const playlistItemSchema=z.object({
  id:id.nullable().optional(),
  uri:z.string().min(1).optional(),
  type:z.enum(['track','episode']).optional(),
  linked_from:z.object({id,type:z.literal('track').optional(),uri:z.string().optional()})
    .refine(value=>value.uri===undefined || value.uri===`spotify:track:${value.id}`).optional(),
});

function playlistTrackMatches(item:unknown,trackId:string):boolean {
  const parsed=playlistItemSchema.safeParse(item);
  if(!parsed.success)throw invalid();
  const value=parsed.data;
  // Local tracks cannot back up a catalog URI. An empty object, however, is
  // unknown state, not evidence that the requested catalog track is absent.
  if(value.uri?.startsWith('spotify:local:')) {
    if(value.id || value.type==='episode')throw invalid();
    return false;
  }
  const uri=value.uri?.match(/^spotify:(track|episode):([A-Za-z0-9]{22})$/);
  if((value.uri && !uri) || (!value.id && !uri))throw invalid();
  if(uri && ((value.id && value.id!==uri[2]) || (value.type && value.type!==uri[1])))throw invalid();
  if(!value.type && !uri)throw invalid();
  if((value.type??uri?.[1])==='episode')return false;
  return (value.id??uri?.[2])===trackId || value.linked_from?.id===trackId;
}
export {WRITE_SCOPES} from './scopes';
export type WriteGuard=()=>Promise<void>;

/** One request per write (except a definitive401 refresh). Caller journals POST intent. */
export class SpotifyMutations {
  private readonly fetcher:Fetch;
  private readonly now:()=>number;
  private readonly timeoutMs:number;
  private blockedUntil=0;
  constructor(private readonly auth:MutationAuthorization,private readonly reads:SpotifyHttp,options:{fetch?:Fetch;now?:()=>number;timeoutMs?:number}={}) {
    this.fetcher=options.fetch??fetch;this.now=options.now??Date.now;this.timeoutMs=options.timeoutMs??15000;
  }
  private async read(userId:string,path:string):Promise<unknown> {
    let credential=await this.auth.accessToken(userId);
    for(let attempt=0;attempt<2;attempt++) {
      try {return await this.reads.json(`https://api.spotify.com/v1${path}`,{headers:{Authorization:`Bearer ${credential.token}`}});}
      catch(error) {
        if(!(error instanceof SpotifyError) || error.statusCode!==401) throw error;
        if(attempt===1) {await this.auth.revoke(userId,credential.version);throw error;}
        credential=await this.auth.accessToken(userId,credential.version);
      }
    }
    throw invalid();
  }
  private async write(userId:string,path:string,method:'POST'|'PUT'|'DELETE',scope:string,body:unknown,guard?:WriteGuard):Promise<unknown> {
    let credential:AccessCredential;
    try {await this.auth.requireScopes(userId,[scope]);credential=await this.auth.accessToken(userId);}
    catch(error) {const safe=safeError(error);throw new MutationRequestError(safe.code,safe.message,safe.statusCode,safe.retryable,'rejected',safe.retryAt);} 
    for(let attempt=0;attempt<2;attempt++) {
      if(this.blockedUntil>this.now()) throw new MutationRequestError('SPOTIFY_RATE_LIMITED','Spotify is rate limiting requests.',429,true,'rejected',this.blockedUntil);
      await guard?.();
      const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      let response:Response;let text:string;
      try {
        ({response,text}=await Promise.race([
          (async()=>{const response=await this.fetcher(`https://api.spotify.com/v1${path}`,{method,redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${credential.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {response,text:await response.text()};})(),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('timeout'));},this.timeoutMs);}),
        ]));
      } catch {controller.abort();throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Spotify did not confirm the write. Reconciliation is required.',503,true,'unknown');}
      finally {clearTimeout(timer);}
      if(response.ok) {if(!text)return null;try{return JSON.parse(text);}catch {throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Spotify returned an invalid write confirmation.',502,true,'unknown');}}
      if(response.status===401) {
        if(attempt===0) {
          try {credential=await this.auth.accessToken(userId,credential.version);}
          catch(error) {const safe=safeError(error);throw new MutationRequestError(safe.code,safe.message,safe.statusCode,safe.retryable,'rejected',safe.retryAt);}
          continue;
        }
        await this.auth.revoke(userId,credential.version);
        throw new MutationRequestError('SPOTIFY_REAUTH_REQUIRED','Reconnect Spotify to continue.',401,false,'rejected');
      }
      if(response.status===429) {
        const raw=response.headers.get('retry-after')??'', seconds=/^\d+(\.\d+)?$/.test(raw.trim())?Number(raw)*1000:NaN;
        this.blockedUntil=this.now()+Math.max(1000,Number.isFinite(seconds)?seconds:Number.isFinite(Date.parse(raw))?Date.parse(raw)-this.now():30000);
        throw new MutationRequestError('SPOTIFY_RATE_LIMITED','Spotify is rate limiting requests.',429,true,'rejected',this.blockedUntil);
      }
      if(response.status>=500) throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Spotify did not confirm the write. Reconciliation is required.',503,true,'unknown');
      throw new MutationRequestError('SPOTIFY_WRITE_REJECTED','Spotify rejected the write. Check account permissions and reconnect if needed.',response.status===403?403:502,false,'rejected');
    }
    throw invalid();
  }
  async isLiked(userId:string,trackId:string):Promise<boolean> {
    const value=await this.read(userId,`/me/library/contains?${new URLSearchParams({uris:`spotify:track:${id.parse(trackId)}`})}`);
    const parsed=z.array(z.boolean()).length(1).safeParse(value);if(!parsed.success)throw invalid();return parsed.data[0]!;
  }
  async setLiked(userId:string,trackId:string,liked:boolean,guard?:WriteGuard):Promise<void> {
    await this.write(userId,`/me/library?${new URLSearchParams({uris:`spotify:track:${id.parse(trackId)}`})}`,liked?'PUT':'DELETE','user-library-modify',undefined,guard);
  }
  marker(userId:string):string {IdSchema.parse(userId);if(!userId.startsWith('spotify:') || userId.length<=8)throw new Error('Invalid Spotify owner');return `sort.fm archive [sortfm:${userId.slice(8)}]`;}
  async createArchive(userId:string,guard?:WriteGuard):Promise<string> {
    const raw=await this.write(userId,'/me/playlists','POST','playlist-modify-private',{name:'sort.fm Archive',public:false,description:this.marker(userId)},guard);
    const result=playlistSchema.safeParse(raw);
    if(!result.success || result.data.owner.id!==userId.slice(8) || result.data.public!==false) throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Spotify did not confirm a private archive playlist.',502,true,'unknown');
    return result.data.id;
  }
  async verifyArchive(userId:string,playlistId:string):Promise<void> {
    await this.auth.requireScopes(userId,['playlist-read-private']);
    const result=playlistSchema.safeParse(await this.read(userId,`/playlists/${id.parse(playlistId)}`));
    if(!result.success || result.data.id!==playlistId)throw invalid();
    if(result.data.owner.id!==userId.slice(8) || result.data.public!==false) throw new SpotifyError('ARCHIVE_NOT_PRIVATE','The archive must be a private playlist owned by this account.',409);
  }
  async findArchive(userId:string):Promise<string|null> {
    await this.auth.requireScopes(userId,['playlist-read-private']);
    let found:string|null=null;
    await this.pages(userId,'/me/playlists',item=>{
      const playlist=playlistSchema.safeParse(item);
      if(!playlist.success)throw invalid();
      if(playlist.data.owner.id===userId.slice(8) && playlist.data.public===false && playlist.data.description===this.marker(userId)) {
        if(found && found!==playlist.data.id)throw new SpotifyError('ARCHIVE_AMBIGUOUS','Multiple managed archive playlists were found. Resolve them before continuing.',409);
        found=playlist.data.id;
      }
      return false;
    });return found;
  }
  async archiveContains(userId:string,playlistId:string,trackId:string):Promise<boolean> {
    id.parse(trackId);await this.auth.requireScopes(userId,['playlist-read-private']);
    return this.pages(userId,`/playlists/${id.parse(playlistId)}/items`,raw=>{
      const entry=z.object({item:z.unknown().optional(),track:z.unknown().optional()}).safeParse(raw);
      if(!entry.success)throw invalid();
      if(!('item' in entry.data) && !('track' in entry.data))throw invalid();
      const item='item' in entry.data?entry.data.item:entry.data.track;
      if(item===null)return false;
      if(item===undefined)throw invalid();
      return playlistTrackMatches(item,trackId);
    });
  }
  async addArchive(userId:string,playlistId:string,trackId:string,guard?:WriteGuard):Promise<void> {
    const result=await this.write(userId,`/playlists/${id.parse(playlistId)}/items`,'POST','playlist-modify-private',{uris:[`spotify:track:${id.parse(trackId)}`]},guard);
    if(!z.object({snapshot_id:z.string().min(1)}).safeParse(result).success) throw new MutationRequestError('SPOTIFY_WRITE_UNCONFIRMED','Spotify did not confirm archive insertion.',502,true,'unknown');
  }
  private async pages(userId:string,path:string,visit:(item:unknown)=>boolean):Promise<boolean> {
    let offset=0,expectedTotal:number|undefined;
    for(let pages=0;pages<10000;pages++) {
      const parsed=pageSchema.safeParse(await this.read(userId,`${path}?limit=50&offset=${offset}`));
      if(!parsed.success)throw invalid();const page=parsed.data;
      if(page.offset!==offset || (expectedTotal!==undefined && expectedTotal!==page.total) || offset+page.items.length>page.total || (!page.items.length && offset<page.total))throw invalid();
      expectedTotal=page.total;
      for(const item of page.items)if(visit(item))return true;
      offset+=page.items.length;if(offset>=page.total)return false;
    }
    throw invalid();
  }
}
