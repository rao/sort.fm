/** D repository -> C1 transport seam. No routing, queue policy or outbox here. */
import {
 FEATURE_VERSION,FitRequestSchema,IdSchema,ObserveRequestSchema,ScoreRequestSchema,
 type FitRequest,type ObserveRequest,type ScoringCandidate,
} from '@sortfm/contracts';
import type {MlClient} from './client';

export interface MlRepositoryPort {
 /** Batch2 sealed labels must never reach the optional online observe path. */
 isSealedCalibrationTrack?(userId:string,trackId:string):Promise<boolean>;
 /** D guarantees the revision and active labels are read in one user-scoped transaction. */
 trainingExamples(userId:string):Promise<{feedbackRevision:number;examples:FitRequest['examples']}>;
}
export interface RepositoryMlOptions {
 repository:MlRepositoryPort;
 client:MlClient;
 /** Fixed for the lifetime of the user's C1 experiment. Use the same seed for settlement. */
 evaluationSeed?:number;
}
export function createRepositoryMl({repository,client,evaluationSeed=42}:RepositoryMlOptions) {
 FitRequestSchema.shape.evaluationSeed.parse(evaluationSeed);
 return {
  /** Queue hot path: no feedback fetch, fitting, enrichment or waiting for other workers. */
  score(userId:string,candidates:ScoringCandidate[],modelVersion:string|null=null){
   return client.score(ScoreRequestSchema.parse({userId,featureVersion:FEATURE_VERSION,candidates,modelVersion}));
  },
  async fit(userId:string){
   IdSchema.parse(userId);
   const snapshot=await repository.trainingExamples(userId);
   // Preserve exposure-time features and fixed splits. Current library/audio can differ.
   return client.fit(FitRequestSchema.parse({userId,featureVersion:FEATURE_VERSION,
    feedbackRevision:snapshot.feedbackRevision,examples:snapshot.examples,evaluationSeed}));
  },
  /** A2 owns durable delivery/retry ordering. Do not send fit+observe for one revision. */
  async observe(event:ObserveRequest){const parsed=ObserveRequestSchema.parse(event);if(await repository.isSealedCalibrationTrack?.(parsed.userId,parsed.trackId))throw new Error('SEALED_EVALUATION_EXCLUDED');return client.observe(parsed);},
  evaluation(userId:string,modelVersion?:string){return client.evaluation({userId,...(modelVersion===undefined?{}:{modelVersion})});},
  explain(userId:string,exposureId:string){return client.explain({userId,exposureId});},
 };
}
export type RepositoryMl=ReturnType<typeof createRepositoryMl>;
