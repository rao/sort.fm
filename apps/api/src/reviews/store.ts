import type {Repository} from '@sortfm/db';
export type {MutationSnapshot,ReviewWorkLease as ReviewLease,ReviewEffectRequest as EffectRequest,ReviewEffect as Effect} from '@sortfm/db';
/** D-owned durable ports, narrowed to the review workflow. */
export type ReviewRepository=Pick<Repository,
 'library'|'getExposure'|'getDecision'|'getDecisionByIdempotencyKey'|'getUndoByIdempotencyKey'|'getCurrentDecision'|
 'createDecision'|'createUndo'|'history'|'trainingExamples'|'claimReviewWork'|'renewReviewWork'|'retryReviewWork'|
 'completeReviewWork'|'transitionMutation'|'settleDecision'|'getArchivePlaylist'|'setArchivePlaylist'|
 'getReviewEffect'|'beginReviewEffect'|'settleReviewEffect'>;
