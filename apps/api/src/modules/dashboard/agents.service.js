import { prisma } from '../../lib/prisma.js';
import { ConflictError } from '../../lib/errors.js';
import { runAgent } from '../../ai/runAgent.js';
import { salesInsightsAgent } from '../../ai/agents/salesInsights.js';
import { ACTIVE_FOLLOW_UP_STATUSES } from '../followUps/followUp.repository.js';
import { rangeWindow } from './metrics.js';

/**
 * Live status of the four RevenuePilot agents, derived from the audit trail
 * (agent_runs) and the follow-up queue (follow_up_jobs). Nothing is simulated:
 * an agent that has never run is reported as idle.
 *
 * Status precedence: running > failed (latest run failed) > scheduled (work
 * queued) > completed (latest run succeeded) > idle (never ran).
 */

const RUNNING_WINDOW_MS = 10 * 60e3;
const INSIGHTS_INTERVAL_MS = 24 * 3600e3;

const NEXT_ACTION_TEXT = {
  AWAIT_OWNER_APPROVAL: 'waiting for your approval',
  AWAIT_LEAD_REPLY: 'waiting for the lead to reply',
  OWNER_ACTION_REQUIRED: 'needs your attention',
  NO_ACTION_NEEDED: 'no action needed',
  RECOMMEND_CLOSE: 'recommends closing the lead',
};

const isFollowUpRun = (run) => run.kind === 'CONVERSATION' && run.input?.goal === 'FOLLOW_UP';

const AGENTS = [
  {
    key: 'lead_intelligence',
    name: 'Lead Intelligence Agent',
    description: 'Analyses each enquiry and scores it 0-100 with reasons.',
    matches: (run) => run.kind === 'QUALIFICATION',
    task: (run) => `Analysing ${run.lead?.name ?? 'a lead'}`,
    decision: (run) =>
      run.output?.score != null
        ? `Scored ${run.lead?.name ?? 'lead'} ${run.output.score}/100${run.output.intent ? ` · ${run.output.intent.toLowerCase()} intent` : ''}`
        : null,
  },
  {
    key: 'conversation',
    name: 'Conversation Agent',
    description: 'Drafts replies and qualifying questions for your approval.',
    matches: (run) => run.kind === 'CONVERSATION' && !isFollowUpRun(run),
    task: (run) => `Drafting a reply to ${run.lead?.name ?? 'a lead'}`,
    decision: (run) => (run.output?.draftMessageId ? `Drafted a reply to ${run.lead?.name ?? 'a lead'} for approval` : null),
  },
  {
    key: 'follow_up',
    name: 'Follow-up Agent',
    description: 'Decides whether and when to follow up, then writes the follow-up.',
    matches: (run) => isFollowUpRun(run) || run.kind === 'FOLLOW_UP_PLANNING',
    task: (run) => (run.kind === 'FOLLOW_UP_PLANNING' ? `Planning follow-up for ${run.lead?.name ?? 'a lead'}` : `Drafting a follow-up for ${run.lead?.name ?? 'a lead'}`),
    decision: (run) => {
      if (run.kind === 'FOLLOW_UP_PLANNING') {
        return run.output?.decision === 'SCHEDULE' ? `Scheduled follow-up ${run.output.step} for ${run.lead?.name ?? 'a lead'}` : `No follow-up for ${run.lead?.name ?? 'a lead'}: ${run.output?.reason ?? ''}`;
      }
      return run.output?.draftMessageId ? `Drafted a follow-up for ${run.lead?.name ?? 'a lead'}` : null;
    },
  },
  {
    key: 'meeting',
    name: 'Meeting Agent',
    description: 'Finds free slots in working hours and books or proposes appointments.',
    matches: (run) => run.kind === 'MEETING',
    task: (run) => `Finding a time with ${run.lead?.name ?? 'a lead'}`,
    decision: (run) =>
      run.output?.appointment
        ? `${run.output.appointment.status === 'CONFIRMED' ? 'Booked' : 'Proposed'} an appointment with ${run.lead?.name ?? 'a lead'}`
        : { CALENDAR_UNAVAILABLE: 'Calendar unavailable', NOT_PERMITTED: 'Booking not permitted' }[run.output?.outcome] ?? 'No suitable slot',
  },
  {
    key: 'sales_intelligence',
    name: 'Sales Intelligence Agent',
    description: 'Decides the next best action per lead and finds pipeline insights.',
    matches: (run) => run.kind === 'ORCHESTRATION' || run.kind === 'SALES_INSIGHTS',
    task: (run) => (run.kind === 'SALES_INSIGHTS' ? 'Analysing your pipeline' : `Planning next steps for ${run.lead?.name ?? 'a lead'}`),
    decision: (run) => {
      if (run.kind === 'SALES_INSIGHTS') {
        const n = run.output?.insights?.length ?? 0;
        return n ? `${n} insight${n > 1 ? 's' : ''}: ${run.output.insights[0].title}` : 'No new insights from current data';
      }
      return run.output?.nextAction ? `${run.lead?.name ?? 'Lead'}: ${NEXT_ACTION_TEXT[run.output.nextAction] ?? run.output.nextAction}` : null;
    },
  },
  {
    key: 'policy',
    name: 'Policy & Approval Agent',
    description: 'Checks consent, autonomy settings and approvals before agents act.',
    matches: (run) => run.kind === 'POLICY_CHECK',
    task: () => 'Validating an action',
    decision: (run) => {
      const verdict = { ALLOW: 'Allowed', REQUIRE_APPROVAL: 'Sent for approval', BLOCK: 'Blocked' }[run.output?.verdict] ?? 'Checked';
      return `${verdict}: ${run.input?.summary ?? run.input?.action ?? 'action'}`;
    },
  },
  {
    key: 'website',
    name: 'Website Intelligence Agent',
    description: 'Reads your website and drafts knowledge (services, prices, FAQs) for you to review.',
    matches: (run) => run.kind === 'WEBSITE_ANALYSIS',
    task: () => 'Reading your website',
    decision: (run) => `Extracted ${run.output?.itemsExtracted ?? 0} items from ${run.output?.pagesFetched ?? 0} pages for your review`,
  },
];

function summariseRun(agent, run) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    trigger: run.trigger,
    lead: run.lead ? { id: run.lead.id, name: run.lead.name } : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    decision: run.status === 'SUCCEEDED' ? agent.decision(run) : null,
    rationale: run.output?.rationale ?? (run.kind === 'POLICY_CHECK' ? (run.output?.reasons ?? []).join('; ') : null),
    error: run.status === 'FAILED' ? (run.error ?? run.errorCode) : null,
  };
}

export async function agentStatus(ctx, { range }) {
  const { since } = rangeWindow(range);
  const now = Date.now();
  const runSelect = {
    id: true,
    kind: true,
    status: true,
    trigger: true,
    input: true,
    output: true,
    error: true,
    errorCode: true,
    startedAt: true,
    finishedAt: true,
    lead: { select: { id: true, name: true } },
  };

  const [recent, inRange, nextFollowUp, followUpCounts] = await Promise.all([
    // Enough recent history to find each agent's latest run.
    prisma.agentRun.findMany({ where: { businessId: ctx.businessId }, orderBy: { createdAt: 'desc' }, take: 200, select: runSelect }),
    prisma.agentRun.findMany({
      where: { businessId: ctx.businessId, ...(since && { createdAt: { gte: since } }) },
      select: { kind: true, status: true, input: true },
    }),
    prisma.followUpJob.findFirst({
      where: { businessId: ctx.businessId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } },
      orderBy: { scheduledFor: 'asc' },
      select: { step: true, status: true, scheduledFor: true, lead: { select: { id: true, name: true } } },
    }),
    prisma.followUpJob.groupBy({
      by: ['status'],
      where: { businessId: ctx.businessId, status: { in: ACTIVE_FOLLOW_UP_STATUSES } },
      _count: { _all: true },
    }),
  ]);
  const queued = Object.fromEntries(followUpCounts.map((r) => [r.status, r._count._all]));
  // Busy businesses: an agent whose last run is older than the recent window still shows its real last run.
  const KIND_OF = { lead_intelligence: 'QUALIFICATION', conversation: 'CONVERSATION', follow_up: ['CONVERSATION', 'FOLLOW_UP_PLANNING'], meeting: 'MEETING', sales_intelligence: ['ORCHESTRATION', 'SALES_INSIGHTS'], policy: 'POLICY_CHECK', website: 'WEBSITE_ANALYSIS' };
  for (const agent of AGENTS) {
    if (recent.some((r) => agent.matches(r) && r.status !== 'RUNNING')) continue;
    const kinds = [KIND_OF[agent.key]].flat();
    const older = await prisma.agentRun.findMany({
      where: { businessId: ctx.businessId, kind: { in: kinds }, status: { in: ['SUCCEEDED', 'FAILED'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: runSelect,
    });
    const match = older.find(agent.matches);
    if (match) recent.push(match);
  }

  return AGENTS.map((agent) => {
    const runs = recent.filter(agent.matches);
    const running = runs.find((r) => r.status === 'RUNNING' && r.startedAt && now - r.startedAt.getTime() < RUNNING_WINDOW_MS);
    const latest = runs.find((r) => r.status === 'SUCCEEDED' || r.status === 'FAILED');
    const rangeRuns = inRange.filter(agent.matches);

    let status = 'idle';
    let currentTask = null;
    let nextRunAt = null;
    let scheduledTask = null;

    if (agent.key === 'follow_up' && nextFollowUp) {
      nextRunAt = nextFollowUp.scheduledFor;
      const verb = { DRAFTING: 'Draft', PENDING_APPROVAL: 'Awaiting approval for', SCHEDULED: 'Send' }[nextFollowUp.status];
      scheduledTask = `${verb} follow-up ${nextFollowUp.step} ${nextFollowUp.status === 'DRAFTING' ? 'for' : 'to'} ${nextFollowUp.lead.name}`;
    }
    if (agent.key === 'sales_intelligence') {
      const lastInsights = runs.find((r) => r.kind === 'SALES_INSIGHTS' && r.status === 'SUCCEEDED');
      if (lastInsights?.finishedAt) nextRunAt = new Date(lastInsights.finishedAt.getTime() + INSIGHTS_INTERVAL_MS);
    }

    if (running) {
      status = 'running';
      currentTask = agent.task(running);
    } else if (latest?.status === 'FAILED') {
      status = 'failed';
      currentTask = scheduledTask;
    } else if (scheduledTask) {
      status = 'scheduled';
      currentTask = scheduledTask;
    } else if (latest) {
      status = 'completed';
    }

    return {
      key: agent.key,
      name: agent.name,
      description: agent.description,
      status,
      currentTask,
      nextRunAt,
      lastRunAt: latest?.finishedAt ?? latest?.startedAt ?? null,
      lastRun: latest ? summariseRun(agent, latest) : null,
      stats: {
        runs: rangeRuns.length,
        succeeded: rangeRuns.filter((r) => r.status === 'SUCCEEDED').length,
        failed: rangeRuns.filter((r) => r.status === 'FAILED').length,
        ...(agent.key === 'follow_up' && {
          queued: (queued.DRAFTING ?? 0) + (queued.PENDING_APPROVAL ?? 0) + (queued.SCHEDULED ?? 0),
        }),
      },
    };
  });
}

// --- Insights -------------------------------------------------------------------

function presentInsights(run, staleSince) {
  if (!run) return null;
  return {
    runId: run.id,
    generatedAt: run.finishedAt,
    model: run.model,
    trigger: run.trigger,
    range: run.output?.range ?? '30d',
    leadsInRange: run.output?.leadsInRange ?? null,
    summary: run.output?.summary ?? null,
    insights: run.output?.insights ?? [],
    newActivitySinceGenerated: staleSince,
  };
}

export async function latestInsights(ctx) {
  const run = await prisma.agentRun.findFirst({
    where: { businessId: ctx.businessId, kind: 'SALES_INSIGHTS', status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
  });
  if (!run) return null;
  const newEvents = await prisma.leadEvent.count({ where: { businessId: ctx.businessId, createdAt: { gt: run.finishedAt } } });
  return presentInsights(run, newEvents);
}

/** Runs the Sales Intelligence agent now (on request or from the daily job). */
export async function generateInsights(ctx, { range = '30d', trigger = 'USER' } = {}) {
  const busy = await prisma.agentRun.count({
    where: { businessId: ctx.businessId, kind: 'SALES_INSIGHTS', status: 'RUNNING', startedAt: { gte: new Date(Date.now() - RUNNING_WINDOW_MS) } },
  });
  if (busy) throw new ConflictError('Insights are already being generated');
  const { run } = await runAgent(salesInsightsAgent, {
    businessId: ctx.businessId,
    leadId: null,
    triggeredById: ctx.userId ?? null,
    trigger,
    triggerDetail: trigger === 'USER' ? 'Owner requested fresh insights' : 'Daily refresh: new activity since the last insights',
    input: { range },
  });
  return presentInsights(run, 0);
}

/**
 * Daily job: refresh insights for businesses with new lead activity since
 * their last insights (or that never had any). Skips quiet businesses so no
 * model calls are spent re-analysing unchanged data.
 */
export async function refreshStaleInsights({ olderThanMs = INSIGHTS_INTERVAL_MS } = {}) {
  const businesses = await prisma.business.findMany({ select: { id: true } });
  const results = { generated: 0, skipped: 0, failed: 0 };
  for (const { id } of businesses) {
    const last = await prisma.agentRun.findFirst({
      where: { businessId: id, kind: 'SALES_INSIGHTS', status: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    if (last && Date.now() - last.finishedAt.getTime() < olderThanMs) {
      results.skipped += 1;
      continue;
    }
    const activity = await prisma.leadEvent.count({ where: { businessId: id, ...(last && { createdAt: { gt: last.finishedAt } }) } });
    if (!activity) {
      results.skipped += 1;
      continue;
    }
    try {
      await generateInsights({ businessId: id }, { range: '30d', trigger: 'SYSTEM' });
      results.generated += 1;
    } catch {
      results.failed += 1; // recorded on the agent run; retried tomorrow
    }
  }
  return results;
}
