import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import * as events from '../../modules/leadEvents/leadEvent.repository.js';
import { AIError } from '../errors.js';
import { defineTool, leadIdField, ToolPolicyError } from './define.js';
import { leadIntelligenceAgent } from '../agents/leadIntelligence.js';
import { conversationAgent, CONVERSATION_GOALS } from '../agents/conversation.js';
import { meetingAgent } from '../agents/meeting.js';
import { evaluatePolicy } from '../policy/policyAgent.js';

export const NEXT_ACTIONS = [
  'AWAIT_OWNER_APPROVAL',
  'AWAIT_LEAD_REPLY',
  'OWNER_ACTION_REQUIRED',
  'NO_ACTION_NEEDED',
  'RECOMMEND_CLOSE',
];

/** Sub-agent failures become tool errors so the orchestrator can adapt. */
async function delegate(runCtx, agent, input, detail) {
  try {
    return await runCtx.runSubAgent(agent, input, detail);
  } catch (err) {
    if (err instanceof AIError && !err.retryable && err.code !== 'AI_MISCONFIGURED') {
      throw new ToolPolicyError(err.code, `${agent.name} agent failed: ${err.message}`, { runId: err.details?.runId });
    }
    throw err; // provider outage or config problem: abort the whole orchestration
  }
}

export const runLeadIntelligence = defineTool({
  name: 'run_lead_intelligence',
  description:
    'Run the lead intelligence agent: it analyses the enquiry (requirements, budget, timeline, intent, missing ' +
    'information) and saves an explainable score. Use when the lead has no analysis or has sent new messages since.',
  access: 'delegate',
  input: z.strictObject({
    lead_id: leadIdField,
    reason: z.string().trim().min(3).max(200).describe('Why analysis is needed now.'),
  }),
  async handler({ reason }, runCtx) {
    if (runCtx.state.executed?.run_lead_intelligence) {
      throw new ToolPolicyError('ALREADY_RUN', 'Lead intelligence already ran in this orchestration.');
    }
    const { run, output } = await delegate(runCtx, leadIntelligenceAgent, { reason }, `Orchestrator: ${reason}`);
    runCtx.state.childRuns.push(run.id);
    return { run_id: run.id, ...output };
  },
});

export const runConversationAgent = defineTool({
  name: 'run_conversation_agent',
  description:
    'Run the conversation agent to draft a reply to the lead for owner approval (it is not sent). Only when the ' +
    'lead is waiting on us and no draft is already pending. Requires an analysis.',
  access: 'delegate',
  input: z.strictObject({
    lead_id: leadIdField,
    // FOLLOW_UP drafts belong to a scheduled follow-up job (the Follow-up Agent); the
    // orchestrator can't create one, or it would be sent immediately as a plain reply.
    goal: z.enum(CONVERSATION_GOALS.filter((g) => g !== 'FOLLOW_UP')),
    guidance: z.string().trim().max(300).optional().describe('Optional pointers, e.g. which question matters most.'),
  }),
  async handler({ lead_id, goal, guidance }, runCtx) {
    if (runCtx.state.executed?.run_conversation_agent) {
      throw new ToolPolicyError('ALREADY_RUN', 'The conversation agent already ran in this orchestration.');
    }
    const lead = await prisma.lead.findFirst({
      where: { id: lead_id, businessId: runCtx.businessId },
      select: { qualification: true },
    });
    if (!lead.qualification) {
      throw new ToolPolicyError('ANALYSIS_REQUIRED', 'Run lead intelligence before drafting a reply.');
    }
    // Automatic runs respect the owner's autonomy setting; an owner pressing "Run AI" is an explicit request.
    if (runCtx.trigger !== 'USER') {
      const policy = await evaluatePolicy({ type: 'GENERATE_RESPONSE', summary: `Automatic reply (${goal.toLowerCase().replace(/_/g, ' ')})` }, { businessId: runCtx.businessId, leadId: lead_id, parentRunId: runCtx.rootRunId });
      if (policy.verdict !== 'ALLOW') throw new ToolPolicyError('AUTO_RESPONSES_OFF', 'Automatic responses are turned off; the owner will reply. Record OWNER_ACTION_REQUIRED.');
    }
    const { run, output } = await delegate(runCtx, conversationAgent, { goal, guidance }, `Orchestrator: ${goal.toLowerCase().replace(/_/g, ' ')}`);
    runCtx.state.childRuns.push(run.id);
    runCtx.state.draftId = output.draftMessageId;
    return { run_id: run.id, ...output };
  },
});

export const recordNextAction = defineTool({
  name: 'record_next_action',
  description: 'Record your final decision about this lead and a short rationale for the owner. Call exactly once, last.',
  access: 'read', // writes only to this run's own audit record
  input: z.strictObject({
    lead_id: leadIdField,
    next_action: z.enum(NEXT_ACTIONS),
    rationale: z.string().trim().min(10).max(500),
  }),
  async handler({ lead_id, next_action, rationale }, runCtx) {
    if (runCtx.state.decision) throw new ToolPolicyError('ALREADY_RECORDED', 'The decision was already recorded.');
    runCtx.state.decision = { nextAction: next_action, rationale };
    // Decisions appear on the lead timeline and the dashboard activity feed.
    await events.record({
      businessId: runCtx.businessId,
      leadId: lead_id,
      type: 'AGENT_DECISION',
      actor: { type: 'AI' },
      data: { nextAction: next_action, rationale, runId: runCtx.runId },
    });
    return { recorded: true };
  },
});

export const runMeetingAgent = defineTool({
  name: 'run_meeting_agent',
  description:
    'Run the Meeting Agent to book a visit, consultation or call when the lead asks for one (or clearly wants to meet). ' +
    'It finds a free slot in working hours and books or proposes it according to the owner\'s settings.',
  access: 'delegate',
  input: z.strictObject({ lead_id: leadIdField, reason: z.string().trim().min(3).max(200).describe('What the lead asked for.') }),
  async handler({ lead_id, reason }, runCtx) {
    if (runCtx.state.executed?.run_meeting_agent) throw new ToolPolicyError('ALREADY_RUN', 'The Meeting Agent already ran in this orchestration.');
    const active = await prisma.appointment.count({ where: { businessId: runCtx.businessId, leadId: lead_id, status: { in: ['PROPOSED', 'CONFIRMED'] } } });
    if (active) throw new ToolPolicyError('APPOINTMENT_EXISTS', 'This lead already has an appointment proposed or booked.');
    const { run, output } = await delegate(runCtx, meetingAgent, { reason }, `Orchestrator: ${reason}`);
    runCtx.state.childRuns.push(run.id);
    return { run_id: run.id, ...output };
  },
});
