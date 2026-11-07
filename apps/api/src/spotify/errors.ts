import type {ErrorEnvelope} from '@sortfm/contracts';

export class SpotifyError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 502, readonly retryable = false, readonly retryAt: number | null = null) {
    super(message);
    this.name = 'SpotifyError';
  }
  envelope(): ErrorEnvelope {return {code:this.code, message:this.message, retryable:this.retryable};}
}
export const authenticationRequired = () => new SpotifyError('AUTHENTICATION_REQUIRED', 'Connect an authorized Spotify account.', 401);
export function safeError(error: unknown): SpotifyError {
  return error instanceof SpotifyError ? error : new SpotifyError('SERVICE_UNAVAILABLE', 'The operation could not be completed. Retry later.', 503, true);
}
