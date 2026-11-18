import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';
import { createMockClaude } from './mock/mockClaude.js';

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`).
 * For others the plain Messages endpoint is used.
 */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-2',
  'claude-fable-5-1',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Thin wrapper around the Anthropic SDK so the agent loop does not care
 * whether it talks to Claude or to the local mock.
 *
 * createMessage({ agent, system, tools, messages }) -> Anthropic.Message
 */
export function createLiveClient({
  model = env.ANTHROPIC_MODEL,
  effort = env.AI_EFFORT,
  maxTokens = env.AI_MAX_TOKENS,
  maxRetries = env.AI_MAX_RETRIES,
  timeout = env.AI_TIMEOUT_MS,
  refusalFallback = env.AI_REFUSAL_FALLBACK,
  apiKey,
  fetch,
} = {}) {
  // With no apiKey the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
  // an `ant auth login` profile. The SDK retries 408/409/429/5xx and
  // connection errors with exponential backoff, honouring retry-after.
  const sdk = new Anthropic({ maxRetries, timeout, ...(apiKey && { apiKey }), ...(fetch && { fetch }) });
  const useFallback = refusalFallback && FALLBACK_MODELS.has(model);

  return {
    mode: 'live',
    model,
    /**
     * Streams the response and returns the complete Message (finalMessage), so long
     * turns never hit the HTTP request timeout. Tool inputs stream as generated
     * (eager_input_streaming); the server then skips its own validation, which is
     * fine here because every tool input is Zod-validated by toolExecutor and
     * runAgent never runs tools from a max_tokens or refusal turn. An unparseable
     * tool input (or a dropped connection) rejects finalMessage with a non-API
     * error: the turn is re-issued, up to 2 times. API errors are rethrown.
     */
    async createMessage({ system, tools, messages }) {
      const params = {
        model,
        max_tokens: maxTokens,
        system,
        tools: tools.map((t) => ({ ...t, eager_input_streaming: true })),
        messages,
        // System prompt and tool definitions are identical across runs.
        cache_control: { type: 'ephemeral' },
        ...(effort && { output_config: { effort } }),
      };
      for (let attempt = 0; ; attempt += 1) {
        const stream = useFallback ? sdk.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }) : sdk.messages.stream(params);
        try {
          return await stream.finalMessage();
        } catch (err) {
          if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
        }
      }
    },
  };
}

let instance = null;

/** Process-wide AI client chosen by AI_MODE. */
export function getAIClient() {
  if (!instance) instance = env.AI_MODE_RESOLVED === 'live' ? createLiveClient() : createMockClaude();
  return instance;
}

/** Test hook: swap the client (e.g. for a scripted fake). Pass null to reset. */
export function setAIClient(client) {
  instance = client;
}
