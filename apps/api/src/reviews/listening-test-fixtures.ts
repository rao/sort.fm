import type {ListeningContextSnapshot} from '@sortfm/contracts';
export function listeningSnapshot(now:number):ListeningContextSnapshot {
 return {source:'spotify-recently-played',completeHistory:false,sampleLimit:50,status:'fresh',asOf:new Date(now).toISOString(),fetchedAt:new Date(now-1000).toISOString(),ageMs:1000,windowStart:new Date(now-30*86400000).toISOString(),cachedEventCount:3,uniqueEventCount:3,windowEventCount:3};
}
