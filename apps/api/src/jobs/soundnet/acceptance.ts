import {z} from 'zod';
import {TITLE_VERIFIER} from './identity';
export const TITLE_ACCEPTANCE='soundnet.title-acceptance.v1';
const sample=z.object({trackId:z.string().regex(/^[A-Za-z0-9]{22}$/),primaryArtist:z.string().min(1),status:z.literal('success'),identityVerified:z.literal(true),endpoint:z.enum(['cached','title_artist']),verifiedAt:z.string().datetime()});
const attempt=z.object({id:z.string().uuid(),version:z.literal(TITLE_ACCEPTANCE),lookupMode:z.literal('title_artist'),verifier:z.literal(TITLE_VERIFIER),createdAt:z.string().datetime(),samples:z.array(sample).length(5)}).passthrough();
/** Diagnostic arrays never count; approval must name this versioned acceptance ID. */
export function validateTitleAcceptance(report:unknown,attemptId:string,now=Date.now()){
 const root=z.object({samples:z.array(z.object({trackId:z.string()})).length(5),acceptanceAttempts:z.array(z.unknown())}).parse(report);
 const candidate=attempt.parse(root.acceptanceAttempts.find(a=>a&&typeof a==='object'&&(a as {id?:unknown}).id===attemptId));
 const created=Date.parse(candidate.createdAt),ids=new Set(root.samples.map(s=>s.trackId));
 if(created>now||now-created>86400000||ids.size!==5||new Set(candidate.samples.map(s=>s.trackId)).size!==5||candidate.samples.some(s=>!ids.has(s.trackId)||Date.parse(s.verifiedAt)<created||Date.parse(s.verifiedAt)>now)||new Set(candidate.samples.map(s=>s.primaryArtist.trim().toLowerCase())).size!==5||!candidate.samples.some(s=>s.endpoint==='title_artist'))throw new Error('INVALID_TITLE_ACCEPTANCE');
 return candidate;
}
