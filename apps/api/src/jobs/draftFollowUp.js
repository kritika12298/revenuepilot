import { UnrecoverableError } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { runAgent } from '../ai/runAgent.js';
import { conversationAgent } from '../ai/agents/conversation.js';
import { AIError } from '../ai/errors.js';
import { logAutomation } from '../modules/automation/audit.js';
import { checkFollowUpEligibility, followUpSettings } from '../modules/followUps/followUp.policy.js';
import { cancelAllForLead } from '../modules/followUps/followUp.service.js';
import * as approvalService from '../modules/approvals/approval.service.js';
import { isFinalAttempt, notifyOwner } from './failures.js';
import { evaluatePolicy } from '../ai/policy/policyAgent.js';

async function finish(fu, status, type, reason, extra = {}) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.followUpJob.updateMany({
      where: { id: fu.id, status: 'DRAFTING' },
      data: { status, ...(status === 'FAILED' ? { lastError: reason } : { skipReason: reason }) },
    });
    if (count) {
      await logAutomation({ businessId: fu.businessId, leadId: fu.leadId, type, data: { followUpId: fu.id, reason, ...extra } }, tx);
    }
  });
  return { outcome: status, reason };
}

/**
 * Drafts a personalised follow-up with the conversation agent (lead context,
 * analysis and conversation history), then hands it to the owner for
 * approval, or auto-approves it if the business opted in.
 */
export async function processDraftFollowUp(job) {
  const { followUpId } = job.data;
  const fu = await prisma.followUpJob.findUnique({
    where: { id: followUpId },
    include: { lead: { include: { business: true } } },
  });
  if (!fu) return { outcome: 'SKIPPED', reason: 'Follow-up no longer exists' };
  if (fu.status !== 'DRAFTING') return { outcome: 'NOOP', reason: `Follow-up is ${fu.status}` };

  const { lead } = fu;
  const eligibility = checkFollowUpEligibility(lead, lead.business);
  if (!eligibility.ok) return finish(fu, 'SKIPPED', 'FOLLOW_UP_SKIPPED', eligibility.reason, { code: eligibility.code });

  if (lead.lastInboundAt && lead.lastInboundAt > fu.createdAt) {
    await prisma.$transaction((tx) => cancelAllForLead(tx, { businessId: fu.businessId, leadId: fu.leadId, reason: 'Lead replied' }));
    return { outcome: 'CANCELLED', reason: 'Lead replied' };
  }
  const pendingDraft = await prisma.approval.count({
    where: { leadId: fu.leadId, type: 'OUTBOUND_MESSAGE', status: 'PENDING' },
  });
  if (pendingDraft) {
    return finish(fu, 'SKIPPED', 'FOLLOW_UP_SKIPPED', 'Another message to this lead is still waiting for approval', { code: 'DRAFT_PENDING' });
  }

  // Automatic follow-ups respect "Write replies automatically". A follow-up the owner
  // scheduled by hand (no anchor message) is an explicit request, like "Run AI".
  if (fu.anchorMessageId) {
    const gen = await evaluatePolicy(
      { type: 'GENERATE_RESPONSE', summary: `Automatic follow-up ${fu.step} to ${lead.name}` },
      { businessId: fu.businessId, leadId: fu.leadId },
    );
    if (gen.verdict !== 'ALLOW') {
      const result = await finish(fu, 'SKIPPED', 'FOLLOW_UP_SKIPPED', 'Automatic responses are turned off; the owner writes follow-ups', { code: 'AUTO_RESPONSES_OFF' });
      await notifyOwner({ businessId: fu.businessId, leadId: fu.leadId, message: `Follow-up ${fu.step} for ${lead.name} is due. Automatic responses are off, so write to them yourself if you want to follow up.` });
      return result;
    }
  }

  const settings = followUpSettings(lead.business);
  const final = fu.step >= settings.maxFollowUps;
  let output;
  let runId;
  try {
    ({ output, run: { id: runId } } = await runAgent(conversationAgent, {
      businessId: fu.businessId,
      leadId: fu.leadId,
      trigger: 'SYSTEM',
      triggerDetail: `Follow-up ${fu.step} of ${settings.maxFollowUps} is due ${fu.scheduledFor.toISOString()}`,
      jobAttempt: job.attemptsMade + 1,
      input: {
        goal: 'FOLLOW_UP',
        followUpId: fu.id,
        guidance: `Follow-up ${fu.step} of ${settings.maxFollowUps}${final ? ' (final follow-up)' : ''}.`,
      },
    }));
  } catch (err) {
    const retry = err instanceof AIError && err.retryable && !isFinalAttempt(job);
    if (retry) throw err; // BullMQ retries with backoff
    const reason = `Could not draft follow-up: ${err.code ?? 'ERROR'} ${err.message}`;
    await finish(fu, 'FAILED', 'FOLLOW_UP_FAILED', reason, { runId: err.details?.runId ?? null });
    await notifyOwner({
      businessId: fu.businessId,
      leadId: fu.leadId,
      message: `Follow-up ${fu.step} for ${lead.name} could not be drafted (${err.code ?? 'error'}). You may want to write to them yourself.`,
    });
    throw new UnrecoverableError(reason);
  }

  const approval = await prisma.$transaction(async (tx) => {
    const { count } = await tx.followUpJob.updateMany({
      where: { id: fu.id, status: 'DRAFTING' },
      data: { status: 'PENDING_APPROVAL', messageId: output.draftMessageId, draftRunId: runId },
    });
    if (!count) {
      // Cancelled while drafting (e.g. the lead replied): withdraw the draft.
      await tx.message.update({ where: { id: output.draftMessageId }, data: { status: 'CANCELLED' } });
      await tx.approval.updateMany({ where: { messageId: output.draftMessageId, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
      return null;
    }
    await logAutomation(
      { businessId: fu.businessId, leadId: fu.leadId, type: 'FOLLOW_UP_DRAFTED', actor: { type: 'AI' }, data: { followUpId: fu.id, runId, messageId: output.draftMessageId } },
      tx,
    );
    return tx.approval.findFirst({ where: { messageId: output.draftMessageId, status: 'PENDING' } });
  });
  if (!approval) return { outcome: 'CANCELLED', reason: 'Follow-up was cancelled while drafting' };

  const message = await prisma.message.findUnique({ where: { id: output.draftMessageId } });
  // The published price list, so a follow-up quoting real prices can still be auto-approved.
  const services = await prisma.service.findMany({ where: { businessId: fu.businessId, active: true } });
  const leadHasWritten = (await prisma.message.count({ where: { conversation: { leadId: lead.id }, direction: 'INBOUND' } })) > 0;
  const policy = await evaluatePolicy(
    { type: 'SEND_EMAIL', kind: 'FOLLOW_UP', lead, business: lead.business, leadHasWritten, text: `${message.subject ?? ''}\n${message.body}`, services, summary: `Follow-up ${fu.step} to ${lead.name}` },
    { businessId: fu.businessId, leadId: fu.leadId, parentRunId: runId },
  );
  if (policy.verdict === 'BLOCK') {
    // Not permitted at all (e.g. consent withdrawn, unpublished price): withdraw the draft instead of asking the owner.
    const reason = `Blocked by policy: ${policy.reasons.join('; ')}`;
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.followUpJob.updateMany({ where: { id: fu.id, status: 'PENDING_APPROVAL' }, data: { status: 'SKIPPED', skipReason: reason } });
      if (!count) return;
      await tx.message.updateMany({ where: { id: message.id, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED' } });
      await tx.approval.updateMany({ where: { messageId: message.id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date(), decisionNote: reason } });
      await logAutomation({ businessId: fu.businessId, leadId: fu.leadId, type: 'FOLLOW_UP_SKIPPED', data: { followUpId: fu.id, reason, code: 'POLICY_BLOCK' } }, tx);
    });
    return { outcome: 'SKIPPED', reason };
  }
  if (policy.verdict === 'ALLOW') {
    await approvalService.approve(
      { businessId: fu.businessId, userId: null },
      approval.id,
      { note: 'Auto-approved: business allows automatic follow-ups' },
      { type: 'SYSTEM' },
    );
    return { outcome: 'SCHEDULED', messageId: output.draftMessageId, autoApproved: true };
  }
  return { outcome: 'PENDING_APPROVAL', messageId: output.draftMessageId };
}
