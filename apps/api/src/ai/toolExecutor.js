import { logger } from '../config/logger.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';
import * as runs from '../modules/agents/agentRun.repository.js';
import { CLOSED_STATUSES } from '../modules/leads/lead.status.js';
import { ToolPolicyError } from './tools/define.js';
import { AIError } from './errors.js';

const MAX_TOOL_CALLS_PER_RUN = 24;

function toolResult(toolUseId, payload, isError = false) {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(payload),
    ...(isError && { is_error: true }),
  };
}

/**
 * Runs one tool call Claude proposed, after:
 *   1. checking the tool is on this agent's allowlist,
 *   2. validating the input with the tool's Zod schema,
 *   3. checking the lead belongs to this run (and therefore this business),
 *   4. refusing writes to closed leads,
 * then lets the handler apply tool-specific business rules.
 *
 * Every call, allowed or not, is written to agent_tool_calls. Failures go back
 * to Claude as `is_error` tool results so it can correct itself.
 */
export async function executeToolCall(toolUse, runCtx) {
  const started = Date.now();
  const tool = runCtx.agent.tools.find((t) => t.name === toolUse.name);
  let outcome = 'EXECUTED';
  let result;
  let errorMessage;

  try {
    runCtx.state.toolCallCount = (runCtx.state.toolCallCount ?? 0) + 1;
    if (runCtx.state.toolCallCount > MAX_TOOL_CALLS_PER_RUN) {
      throw new ToolPolicyError('TOOL_BUDGET_EXCEEDED', 'Too many tool calls in this run; finish now.');
    }
    if (!tool) {
      outcome = 'PERMISSION_DENIED';
      throw new ToolPolicyError('TOOL_NOT_ALLOWED', `Tool "${toolUse.name}" is not available to this agent.`);
    }

    const parsed = tool.input.safeParse(toolUse.input ?? {});
    if (!parsed.success) {
      outcome = 'VALIDATION_FAILED';
      throw new ToolPolicyError(
        'INVALID_INPUT',
        'Tool input failed validation. Fix the listed fields and call the tool again.',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const input = parsed.data;

    if (tool.scope === 'lead') {
      if (input.lead_id !== runCtx.leadId) {
        outcome = 'PERMISSION_DENIED';
        throw new ToolPolicyError('LEAD_OUT_OF_SCOPE', 'This run may only act on the lead it was started for.');
      }
      // Re-read every time: the lead may have changed or been deleted mid-run.
      const lead = await prisma.lead.findFirst({
        where: { id: input.lead_id, businessId: runCtx.businessId },
        select: { id: true, status: true },
      });
      if (!lead) {
        outcome = 'PERMISSION_DENIED';
        throw new ToolPolicyError('LEAD_NOT_FOUND', 'Lead not found for this business.');
      }
      if (tool.access !== 'read' && CLOSED_STATUSES.has(lead.status)) {
        outcome = 'POLICY_BLOCKED';
        throw new ToolPolicyError('LEAD_CLOSED', `Lead is ${lead.status}; no further actions are allowed.`);
      }
    }

    result = await tool.handler(input, runCtx);
    return { block: toolResult(toolUse.id, result ?? { ok: true }), outcome };
  } catch (err) {
    // Provider outages / misconfiguration in a sub-agent abort the whole run.
    if (err instanceof AIError) {
      outcome = 'ERROR';
      errorMessage = `${err.code}: ${err.message}`;
      result = { error: err.code, message: err.message };
      throw err;
    }
    let payload;
    if (err instanceof ToolPolicyError) {
      if (outcome === 'EXECUTED') outcome = 'POLICY_BLOCKED';
      payload = { error: err.code, message: err.message, ...(err.details && { details: err.details }) };
    } else if (err instanceof AppError && err.status < 500) {
      // Business-rule rejections from services (e.g. invalid status transition).
      outcome = 'POLICY_BLOCKED';
      payload = { error: err.code, message: err.message, ...(err.details && { details: err.details }) };
    } else {
      outcome = 'ERROR';
      logger.error({ err, runId: runCtx.runId, tool: toolUse.name }, 'Tool handler failed');
      payload = { error: 'TOOL_FAILED', message: 'The tool failed unexpectedly. Do not retry it.' };
    }
    errorMessage = payload.message;
    result = payload;
    return { block: toolResult(toolUse.id, payload, true), outcome };
  } finally {
    await runs.recordToolCall({
      businessId: runCtx.businessId,
      agentRunId: runCtx.runId,
      toolUseId: toolUse.id,
      toolName: String(toolUse.name).slice(0, 64),
      input: toolUse.input ?? {},
      outcome,
      result: result ?? null,
      error: errorMessage ?? null,
      durationMs: Date.now() - started,
    });
    if (outcome === 'EXECUTED') {
      runCtx.state.executed ??= {};
      runCtx.state.executed[toolUse.name] = (runCtx.state.executed[toolUse.name] ?? 0) + 1;
    }
  }
}
