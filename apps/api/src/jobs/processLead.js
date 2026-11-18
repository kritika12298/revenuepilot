import { prisma } from '../lib/prisma.js';
import { runAgent } from '../ai/runAgent.js';
import { orchestratorAgent } from '../ai/agents/orchestrator.js';
import { AIError } from '../ai/errors.js';
import { evaluatePolicy } from '../ai/policy/policyAgent.js';
import { CLOSED_STATUSES } from '../modules/leads/lead.status.js';
import { getQueues, QUEUES } from '../queue/queues.js';
import { isFinalAttempt } from './failures.js';

export const JOB_PROCESS_LEAD = 'process-lead';

/** Queue automatic processing of a new enquiry or reply (deduplicated per message). */
export async function enqueueProcessLead({ businessId, leadId, trigger, detail, dedupe }) {
  await getQueues()[QUEUES.FOLLOW_UPS].add(
    JOB_PROCESS_LEAD,
    { businessId, leadId, trigger, detail },
    { jobId: `process-${leadId}-${dedupe}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
  );
}

/**
 * Observe → understand → decide: run the Sales Orchestrator on a lead that
 * just wrote in, if the owner allows automatic processing.
 */
export async function processLead(job) {
  const { businessId, leadId, trigger, detail } = job.data;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, businessId }, select: { id: true, status: true } });
  if (!lead) return { outcome: 'SKIPPED', reason: 'Lead not found' };
  if (CLOSED_STATUSES.has(lead.status)) return { outcome: 'SKIPPED', reason: `Lead is ${lead.status}` };

  const policy = await evaluatePolicy({ type: 'AUTO_PROCESS_LEAD', summary: detail }, { businessId, leadId, triggerDetail: detail });
  if (policy.verdict !== 'ALLOW') return { outcome: 'SKIPPED', reason: 'Automatic lead processing is turned off' };

  const busy = await prisma.agentRun.count({
    where: { businessId, leadId, parentRunId: null, status: 'RUNNING', startedAt: { gte: new Date(Date.now() - 10 * 60e3) } },
  });
  if (busy) throw new Error('Another agent run is in progress for this lead; retrying later');

  try {
    const { run, output } = await runAgent(orchestratorAgent, {
      businessId,
      leadId,
      trigger,
      triggerDetail: detail,
      jobAttempt: job.attemptsMade + 1,
      input: { reason: detail },
    });
    return { outcome: 'PROCESSED', runId: run.id, nextAction: output.nextAction };
  } catch (err) {
    if (err instanceof AIError && err.retryable && !isFinalAttempt(job)) throw err;
    return { outcome: 'FAILED', reason: err.message };
  }
}
