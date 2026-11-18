import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import { AGENTS } from '../../ai/agents/index.js';
import { runAgent } from '../../ai/runAgent.js';
import { getAIClient } from '../../ai/client.js';
import { CLOSED_STATUSES } from '../leads/lead.status.js';
import * as runs from './agentRun.repository.js';
import { presentRun } from './runPresenter.js';

/** A RUNNING run older than this is treated as crashed. */
const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Starts an agent for a lead on behalf of an authenticated user.
 * Ownership, lead state and concurrency are checked here, before any model
 * call; tool-level permissions are enforced again inside the run.
 */
export async function start(ctx, leadId, { agent: agentName, goal, reason }) {
  const agent = AGENTS[agentName];
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, businessId: ctx.businessId },
    select: { id: true, status: true, qualification: true },
  });
  if (!lead) throw new NotFoundError('Lead');
  if (CLOSED_STATUSES.has(lead.status)) {
    throw new UnprocessableError('LEAD_CLOSED', `Lead is ${lead.status}; agents do not run on closed leads`);
  }
  if (agentName === 'conversation' && !lead.qualification) {
    throw new UnprocessableError('ANALYSIS_REQUIRED', 'Run lead intelligence (or the orchestrator) first');
  }

  const now = Date.now();
  await runs.failStaleRuns(ctx.businessId, leadId, new Date(now - STALE_AFTER_MS));
  if (await runs.hasRunningTopLevel(ctx.businessId, leadId, new Date(now - STALE_AFTER_MS))) {
    throw new ConflictError('An agent is already working on this lead; try again when it finishes');
  }

  const input = {
    ...(goal && { goal }),
    ...(reason && { reason }),
  };
  const { run } = await runAgent(agent, {
    businessId: ctx.businessId,
    leadId,
    triggeredById: ctx.userId,
    trigger: 'USER',
    triggerDetail: 'Started from the dashboard (Run AI)',
    input,
  });
  return getRun(ctx, run.id);
}

export async function listForLead(ctx, leadId, { page, pageSize }) {
  const lead = await prisma.lead.count({ where: { id: leadId, businessId: ctx.businessId } });
  if (!lead) throw new NotFoundError('Lead');
  const { rows, total } = await runs.listTopLevel(ctx.businessId, { leadId, ...toSkipTake({ page, pageSize }) });
  return paginated(rows.map(presentTree), total, { page, pageSize });
}

const presentTree = (run) => ({ ...presentRun(run), childRuns: (run.childRuns ?? []).map(presentRun) });

export async function getRun(ctx, id) {
  const run = await runs.findDetail(ctx.businessId, id);
  if (!run) throw new NotFoundError('Agent run');
  return presentTree(run);
}

const KIND_FILTERS = {
  orchestrator: ['ORCHESTRATION'],
  lead_intelligence: ['QUALIFICATION'],
  conversation: ['CONVERSATION'],
  follow_up: ['FOLLOW_UP_PLANNING', 'CONVERSATION'],
  meeting: ['MEETING'],
  policy: ['POLICY_CHECK'],
  sales_intelligence: ['SALES_INSIGHTS'],
  website: ['WEBSITE_ANALYSIS'],
};

/** Business-wide AI execution timeline. */
export async function listAll(ctx, { page, pageSize, agent, status, leadId, days }) {
  const since = days ? new Date(Date.now() - days * 86_400_000) : null;
  const { rows, total } = await runs.listTopLevel(ctx.businessId, {
    kind: agent ? KIND_FILTERS[agent] : undefined,
    status,
    leadId,
    since,
    ...toSkipTake({ page, pageSize }),
  });
  let data = rows.map(presentTree);
  if (agent === 'follow_up') data = data.filter((r) => r.agentName === 'Follow-up Agent');
  if (agent === 'conversation') data = data.filter((r) => r.agentName === 'Conversation Agent');
  return paginated(data, total, { page, pageSize });
}

export function status() {
  const ai = getAIClient();
  return {
    mode: ai.mode,
    model: ai.mode === 'live' ? ai.model : 'mock',
    effort: ai.mode === 'live' ? env.AI_EFFORT : null,
    agents: Object.keys(AGENTS),
  };
}
