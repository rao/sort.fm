import type {PlaybackGrantPurpose} from '@sortfm/contracts';
export function playbackCookieName(secure:boolean,purpose:PlaybackGrantPurpose){return `${secure?'__Host-':''}sortfm_playback_${purpose}`;}
export function playbackCookie(secure:boolean,purpose:PlaybackGrantPurpose,value:string,maxAge:number){
 return `${playbackCookieName(secure,purpose)}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure?'; Secure':''}`;
}
export function readCookie(header:string|undefined,name:string){
 const matches=(header??'').split(';').map(x=>x.trim()).filter(x=>x.slice(0,x.indexOf('='))===name);
 if(matches.length!==1)return undefined;
 try{return decodeURIComponent(matches[0]!.slice(name.length+1));}catch{return undefined;}
}
