import {z} from 'zod';
import {CountSchema,TimestampSchema} from './schemas';
import type {ScoringCandidate} from './features';

/** Server-only exposure provenance; sample coverage is never complete listening history. */
export const ListeningContextSnapshotSchema=z.strictObject({
 source:z.literal('spotify-recently-played'),completeHistory:z.literal(false),sampleLimit:z.literal(50),
 status:z.enum(['fresh','missing','read_error','owner_mismatch','invalid','provider_error','future','stale']),
 asOf:TimestampSchema,fetchedAt:TimestampSchema.nullable(),ageMs:CountSchema.nullable(),windowStart:TimestampSchema,
 cachedEventCount:CountSchema.max(50).nullable(),uniqueEventCount:CountSchema.max(50).nullable(),windowEventCount:CountSchema.max(50).nullable(),
}).superRefine((s,ctx)=>{
 const at=Date.parse(s.asOf),fetched=s.fetchedAt===null?null:Date.parse(s.fetchedAt);
 const age=fetched===null||fetched>at?null:at-fetched;
 const unknown=['missing','read_error','owner_mismatch','invalid'].includes(s.status);
 const countsKnown=s.cachedEventCount!==null&&s.uniqueEventCount!==null&&s.windowEventCount!==null;
 const validCounts=countsKnown&&s.windowEventCount!<=s.uniqueEventCount!&&s.uniqueEventCount!<=s.cachedEventCount!;
 if(Date.parse(s.windowStart)!==at-30*86_400_000||s.ageMs!==age
  ||(unknown&&(s.fetchedAt!==null||s.cachedEventCount!==null||s.uniqueEventCount!==null||s.windowEventCount!==null))
  ||(!unknown&&(s.fetchedAt===null||s.cachedEventCount===null))
  ||(s.status==='fresh'&&(age===null||age>86_400_000||!validCounts))
  ||(s.status==='stale'&&(age===null||age<=86_400_000))
  ||(s.status!=='fresh'&&(s.uniqueEventCount!==null||s.windowEventCount!==null)))
  ctx.addIssue({code:'custom',message:'Listening coverage must preserve owner-scoped sample freshness and missingness'});
});
export type ListeningContextSnapshot=z.infer<typeof ListeningContextSnapshotSchema>;
/** New batch assembly may load cached provenance once; retries reuse this frozen result. */
export type CandidateAssemblySnapshot={candidates:ScoringCandidate[];listeningContext?:ListeningContextSnapshot};
