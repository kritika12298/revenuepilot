/**
 * A fake Claude that replays a script. Each step receives the request params
 * and returns content blocks (or a full response, or throws). Requests are
 * recorded so tests can assert what was sent back to the model.
 */
let seq = 0;

export const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_test_${(seq += 1)}`, name, input });
export const text = (t) => ({ type: 'text', text: t });

export function scriptedClient(steps) {
  const requests = [];
  return {
    mode: 'live',
    model: 'scripted-model',
    requests,
    async createMessage(params) {
      requests.push(structuredClone(params));
      const step = steps[requests.length - 1];
      if (!step) throw new Error(`Script exhausted after ${steps.length} steps`);
      const out = await step(params);
      if (!Array.isArray(out)) return out;
      return {
        id: `msg_test_${(seq += 1)}`,
        type: 'message',
        role: 'assistant',
        model: 'scripted-model',
        content: out,
        stop_reason: out.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    },
  };
}

/** The tool_result blocks sent in a given request (the last user turn). */
export function toolResultsIn(request) {
  const last = request.messages.at(-1);
  return Array.isArray(last.content)
    ? last.content.filter((b) => b.type === 'tool_result').map((b) => ({ ...b, payload: JSON.parse(b.content) }))
    : [];
}
