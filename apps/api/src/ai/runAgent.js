import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import * as runs from '../modules/agents/agentRun.repository.js';
import { getAIClient } from './client.js';
import { AIError, classifyAIError } from './errors.js';
import { executeToolCall } from './toolExecutor.js';
import { publishEvent } from '../modules/events/eventBus.js';

const MAX_DEPTH = 1; // orchestrator (0) -> sub-agent (1); sub-agents cannot delegate.

function textOf(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Runs one agent to completion with Claude's tool-use loop:
 *
 *   request -> tool_use blocks -> backend executes (validated, authorised,
 *   audited) -> tool_result blocks -> request ... until the agent has done
 *   its required work and ends its turn.
 *
 * Every run is persisted as an AgentRun (with token usage, stop reason and
 * errors) and every proposed tool call as an AgentToolCall.
 *
 * @returns {Promise<{ run: object, output: object }>}
 * @throws {AIError} after recording the failure on the run
 */
export async function runAgent(
  agent,
  { businessId, leadId, triggeredById = null, trigger = 'USER', triggerDetail = null, jobAttempt = null, parentRunId = null, rootRunId = null, depth = 0, input = {}, state = {} },
) {
  if (depth > MAX_DEPTH) throw new AIError('AI_DEPTH_EXCEEDED', 'Sub-agents cannot start further agents');

  const ai = getAIClient();
  const startedAt = new Date();
  const run = await runs.create({
    businessId,
    leadId,
    parentRunId,
    kind: agent.kind,
    status: 'RUNNING',
    trigger,
    triggerDetail,
    jobAttempt,
    triggeredById,
    model: ai.mode === 'mock' ? 'mock' : ai.model,
    input,
    startedAt,
  });
  const log = logger.child({ runId: run.id, agent: agent.name, businessId, leadId });
  log.info({ trigger, parentRunId }, 'Agent run started');
  publishEvent(businessId, 'agent-run', { id: run.id, kind: agent.kind, status: 'RUNNING', leadId });

  const runCtx = {
    businessId,
    leadId,
    runId: run.id,
    rootRunId: rootRunId ?? run.id,
    trigger,
    triggeredById,
    depth,
    agent,
    state: { ...agent.initialState(input), ...state },
    runSubAgent: (subAgent, subInput, detail) =>
      runAgent(subAgent, {
        businessId,
        leadId,
        triggeredById,
        trigger: 'ORCHESTRATOR',
        triggerDetail: detail ?? `Delegated by the Sales Orchestrator`,
        parentRunId: run.id,
        rootRunId: rootRunId ?? run.id,
        depth: depth + 1,
        input: subInput,
      }),
  };

  const tools = agent.tools.map((t) => t.definition);
  const messages = [{ role: 'user', content: agent.userPrompt({ leadId, ...input }) }];
  const usage = { input: 0, output: 0 };
  let iterations = 0;
  let nudged = false;
  let stopReason = null;
  let servedModel = null;

  try {
    for (;;) {
      if (iterations >= env.AI_MAX_ITERATIONS) {
        // The work is recorded (e.g. the orchestrator saved its decision on the last
        // turn); only the closing text turn is missing. Finish rather than fail a run
        // whose side effects have already happened.
        if (agent.isComplete(runCtx.state)) break;
        throw new AIError('AI_LOOP_LIMIT', `Agent did not finish within ${env.AI_MAX_ITERATIONS} model calls`);
      }
      iterations += 1;

      let response;
      try {
        response = await ai.createMessage({ agent: agent.name, system: agent.system, tools, messages });
      } catch (err) {
        throw classifyAIError(err) ?? err;
      }

      servedModel = response.model ?? servedModel;
      usage.input += (response.usage?.input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0);
      usage.output += response.usage?.output_tokens ?? 0;
      stopReason = response.stop_reason;

      if (stopReason === 'refusal') {
        throw new AIError('AI_REFUSED', 'Claude declined to handle this request', {
          status: 422,
          details: { category: response.stop_details?.category ?? null },
        });
      }
      // Never run tools from a truncated turn: their input may be cut off.
      if (stopReason === 'max_tokens') {
        throw new AIError('AI_OUTPUT_TRUNCATED', 'Claude ran out of output tokens; raise AI_MAX_TOKENS');
      }

      // Append the assistant turn unchanged (thinking blocks included).
      messages.push({ role: 'assistant', content: response.content });

      if (stopReason === 'pause_turn') continue;

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length) {
        // Sequential on purpose: writes must not race each other.
        const results = [];
        for (const toolUse of toolUses) results.push((await executeToolCall(toolUse, runCtx)).block);
        // All results for one turn go back in a single user message.
        messages.push({ role: 'user', content: results });
        continue;
      }

      if (agent.isComplete(runCtx.state)) break;
      if (nudged) {
        throw new AIError('AI_INCOMPLETE', `Agent ended without completing: ${agent.describeMissing(runCtx.state)}`);
      }
      nudged = true;
      messages.push({ role: 'user', content: agent.nudge(runCtx.state) });
    }

    const output = agent.output(runCtx.state, textOf(messages.at(-1).content));
    const finished = await runs.update(run.id, {
      status: 'SUCCEEDED',
      output,
      model: ai.mode === 'mock' ? 'mock' : (servedModel ?? ai.model),
      stopReason,
      iterations,
      inputTokens: usage.input,
      outputTokens: usage.output,
      latencyMs: Date.now() - startedAt.getTime(),
      finishedAt: new Date(),
    });
    log.info({ iterations, inputTokens: usage.input, outputTokens: usage.output, latencyMs: finished.latencyMs }, 'Agent run succeeded');
    publishEvent(businessId, 'agent-run', { id: run.id, kind: agent.kind, status: 'SUCCEEDED', leadId });
    return { run: finished, output };
  } catch (err) {
    const aiErr = err instanceof AIError ? err : new AIError('AI_INTERNAL', 'Agent run failed unexpectedly', { status: 500, cause: err });
    await runs.update(run.id, {
      status: 'FAILED',
      errorCode: aiErr.code,
      error: aiErr.message,
      output: agent.output(runCtx.state, null),
      model: ai.mode === 'mock' ? 'mock' : (servedModel ?? ai.model),
      stopReason,
      iterations,
      inputTokens: usage.input,
      outputTokens: usage.output,
      latencyMs: Date.now() - startedAt.getTime(),
      finishedAt: new Date(),
    });
    log[aiErr.status >= 500 ? 'error' : 'warn']({ err: aiErr.cause ?? aiErr, code: aiErr.code }, 'Agent run failed');
    aiErr.details = { ...(aiErr.details ?? {}), runId: run.id };
    publishEvent(businessId, 'agent-run', { id: run.id, kind: agent.kind, status: 'FAILED', leadId });
    throw aiErr;
  }
}
