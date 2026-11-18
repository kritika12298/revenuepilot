import Anthropic from '@anthropic-ai/sdk';
import { AppError } from '../lib/errors.js';

/**
 * Errors from running an agent. `code` is stored on the AgentRun and returned
 * to API clients; `retryable` tells callers (and later the job queue) whether
 * trying again later can help.
 */
export class AIError extends AppError {
  constructor(code, message, { status = 502, retryable = false, cause, details } = {}) {
    super(status, code, message, details);
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

/**
 * Maps SDK errors to AIErrors, most specific class first. The SDK has already
 * retried 408/409/429/5xx and connection errors (AI_MAX_RETRIES) by the time
 * one of these reaches us, so what is left is either permanent or an outage.
 */
export function classifyAIError(err) {
  if (err instanceof AIError) return err;

  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AIError('AI_MISCONFIGURED', 'The AI provider rejected our credentials', { status: 500, cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AIError('AI_MISCONFIGURED', 'The configured Claude model was not found', { status: 500, cause: err });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return new AIError('AI_BAD_REQUEST', 'The AI provider rejected the request', { status: 502, cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AIError('AI_RATE_LIMITED', 'The AI provider is rate limiting us, please retry shortly', {
      status: 503,
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AIError('AI_TIMEOUT', 'The AI provider timed out', { status: 504, retryable: true, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIError('AI_UNAVAILABLE', 'Could not reach the AI provider', { status: 503, retryable: true, cause: err });
  }
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && err.status >= 500)) {
    return new AIError('AI_UNAVAILABLE', 'The AI provider is temporarily unavailable', {
      status: 503,
      retryable: true,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    return new AIError('AI_ERROR', 'The AI provider returned an error', { status: 502, cause: err });
  }
  return null;
}
