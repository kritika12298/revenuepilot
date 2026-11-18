import { prisma } from '../../lib/prisma.js';

export function create(data, db = prisma) {
  return db.agentRun.create({ data });
}

export function update(id, data, db = prisma) {
  return db.agentRun.update({ where: { id }, data });
}

export function recordToolCall(data, db = prisma) {
  return db.agentToolCall.create({ data });
}

const runSummarySelect = {
  id: true,
  kind: true,
  input: true,
  triggerDetail: true,
  jobAttempt: true,
  lead: { select: { id: true, name: true } },
  status: true,
  trigger: true,
  model: true,
  output: true,
  stopReason: true,
  errorCode: true,
  error: true,
  iterations: true,
  inputTokens: true,
  outputTokens: true,
  latencyMs: true,
  startedAt: true,
  finishedAt: true,
  parentRunId: true,
  leadId: true,
  triggeredBy: { select: { id: true, name: true } },
};

const toolCallSelect = {
  id: true,
  toolUseId: true,
  toolName: true,
  input: true,
  outcome: true,
  result: true,
  error: true,
  durationMs: true,
  createdAt: true,
};

export async function listTopLevelForLead(businessId, leadId, { skip, take }, db = prisma) {
  const where = { businessId, leadId, parentRunId: null };
  const [rows, total] = await Promise.all([
    db.agentRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        ...runSummarySelect,
        childRuns: { orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, status: true, errorCode: true } },
        _count: { select: { toolCalls: true } },
      },
    }),
    db.agentRun.count({ where }),
  ]);
  return { rows, total };
}

/** Full audit view of one run: its tool calls and its sub-agent runs. */
export function findDetail(businessId, id, db = prisma) {
  return db.agentRun.findFirst({
    where: { id, businessId },
    select: {
      ...runSummarySelect,
      input: true,
      toolCalls: { orderBy: { createdAt: 'asc' }, select: toolCallSelect },
      childRuns: {
        orderBy: { createdAt: 'asc' },
        select: { ...runSummarySelect, toolCalls: { orderBy: { createdAt: 'asc' }, select: toolCallSelect } },
      },
    },
  });
}

/** Mark runs that never finished (crash, deploy) so they stop looking active. */
export function failStaleRuns(businessId, leadId, olderThan, db = prisma) {
  return db.agentRun.updateMany({
    where: { businessId, leadId, status: 'RUNNING', startedAt: { lt: olderThan } },
    data: { status: 'FAILED', errorCode: 'STALE', error: 'Run did not finish', finishedAt: new Date() },
  });
}

export function hasRunningTopLevel(businessId, leadId, since, db = prisma) {
  return db.agentRun
    .count({ where: { businessId, leadId, parentRunId: null, status: 'RUNNING', startedAt: { gte: since } } })
    .then((n) => n > 0);
}

/** Business-wide execution timeline: top-level runs, newest first, with sub-agent runs nested. */
export async function listTopLevel(businessId, { kind, status, leadId, since, skip, take }, db = prisma) {
  const where = {
    businessId,
    parentRunId: null,
    ...(kind && { kind: { in: kind } }),
    ...(status && { status }),
    ...(leadId && { leadId }),
    ...(since && { createdAt: { gte: since } }),
  };
  const [rows, total] = await Promise.all([
    db.agentRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        ...runSummarySelect,
        childRuns: { orderBy: { createdAt: 'asc' }, select: { ...runSummarySelect, _count: { select: { toolCalls: true } } } },
        _count: { select: { toolCalls: true } },
      },
    }),
    db.agentRun.count({ where }),
  ]);
  return { rows, total };
}
