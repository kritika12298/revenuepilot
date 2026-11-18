import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createLiveClient } from '../../src/ai/client.js';
import { classifyAIError } from '../../src/ai/errors.js';

/**
 * Exercises the real Anthropic SDK client with a fake `fetch`, so request
 * shape, retries and error mapping are tested without network or cost.
 */

const okBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
};

/** A successful Messages API response as the server-sent event stream the SDK reads. */
function sse(message) {
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } } }],
    ...message.content.flatMap((block, index) =>
      block.type === 'text'
        ? [
            ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }],
            ['content_block_stop', { type: 'content_block_stop', index }],
          ]
        : [
            ['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: block.rawInput ?? JSON.stringify(block.input) } }],
            ['content_block_stop', { type: 'content_block_stop', index }],
          ],
    ),
    ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function fakeFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    const [status, body] = responses[Math.min(calls.length - 1, responses.length - 1)];
    const headers = { 'retry-after-ms': '1', 'request-id': `req_${calls.length}` };
    if (status === 200) return new Response(sse(body), { status, headers: { ...headers, 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const request = { agent: 'x', system: 'sys', tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'hi' }] };
const errorBody = (type) => ({ type: 'error', error: { type, message: type } });

describe('live Anthropic client', () => {
  it('sends the configured model, effort, caching and refusal fallback', async () => {
    const { fetch, calls } = fakeFetch([[200, okBody]]);
    const client = createLiveClient({ apiKey: 'test-key', fetch, model: 'claude-opus-5-5', effort: 'low', maxTokens: 4000 });
    const res = await client.createMessage(request);

    expect(res.content[0].text).toBe('hi');
    const { body, headers, url } = calls[0];
    expect(url).toContain('/v1/messages');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      system: 'sys',
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
      stream: true,
    });
    expect(body.tools[0]).toMatchObject({ name: 't', eager_input_streaming: true });
    expect(body.agent).toBeUndefined();
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('omits fallback and effort for models or configs that do not use them', async () => {
    const { fetch, calls } = fakeFetch([[200, okBody]]);
    await createLiveClient({ apiKey: 'k', fetch, model: 'claude-haiku-4-5', effort: null }).createMessage(request);
    expect(calls[0].body.fallbacks).toBeUndefined();
    expect(calls[0].body.output_config).toBeUndefined();
    expect(calls[0].headers.get('anthropic-beta')).toBeNull();
  });

  it('retries overloaded and rate-limited responses, then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      [529, errorBody('overloaded_error')],
      [429, errorBody('rate_limit_error')],
      [200, okBody],
    ]);
    const res = await createLiveClient({ apiKey: 'k', fetch, maxRetries: 3 }).createMessage(request);
    expect(res.id).toBe('msg_1');
    expect(calls).toHaveLength(3);
  });

  it('gives up after maxRetries and classifies the error as retryable', async () => {
    const { fetch, calls } = fakeFetch([[429, errorBody('rate_limit_error')]]);
    const err = await createLiveClient({ apiKey: 'k', fetch, maxRetries: 2 }).createMessage(request).catch((e) => e);
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(calls).toHaveLength(3);
    expect(classifyAIError(err)).toMatchObject({ code: 'AI_RATE_LIMITED', status: 503, retryable: true });
  });

  it('does not retry authentication errors', async () => {
    const { fetch, calls } = fakeFetch([[401, errorBody('authentication_error')]]);
    const err = await createLiveClient({ apiKey: 'bad', fetch, maxRetries: 3 }).createMessage(request).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(classifyAIError(err)).toMatchObject({ code: 'AI_MISCONFIGURED', retryable: false });
  });

  it('classifies bad requests and unknown models as non-retryable', async () => {
    const bad = await createLiveClient({ apiKey: 'k', fetch: fakeFetch([[400, errorBody('invalid_request_error')]]).fetch })
      .createMessage(request)
      .catch((e) => e);
    expect(classifyAIError(bad)).toMatchObject({ code: 'AI_BAD_REQUEST', retryable: false });

    const missing = await createLiveClient({ apiKey: 'k', fetch: fakeFetch([[404, errorBody('not_found_error')]]).fetch })
      .createMessage(request)
      .catch((e) => e);
    expect(classifyAIError(missing)).toMatchObject({ code: 'AI_MISCONFIGURED' });
  });

  it('returns streamed tool_use blocks, and re-issues a turn whose tool input could not be parsed', async () => {
    const toolTurn = (rawInput) => ({ ...okBody, content: [{ type: 'tool_use', id: 'toolu_1', name: 't', input: {}, rawInput }], stop_reason: 'tool_use' });
    const { fetch, calls } = fakeFetch([
      [200, toolTurn('}} not json {{')],
      [200, toolTurn('{"lead_id":"abc"}')],
    ]);
    const res = await createLiveClient({ apiKey: 'k', fetch }).createMessage(request);
    expect(calls).toHaveLength(2);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content[0]).toMatchObject({ type: 'tool_use', name: 't', input: { lead_id: 'abc' } });
  });
});
