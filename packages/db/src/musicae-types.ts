import type {FeatureVector} from '@sortfm/contracts';
export type MusicaeOutcome={trackId:string;status:'success'|'quarantined'|'unavailable'|'failed';code:string|null;raw:unknown;values?:FeatureVector['values']};
export type MusicaeResponse={raw:unknown;httpStatus:number;latencyMs:number;remaining:number|null;limit:number|null;resetSeconds:number|null;retryAfterMs:number;bytes:number};
