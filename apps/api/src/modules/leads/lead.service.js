import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ConflictError, NotFoundError, UnprocessableError } from '../../lib/errors.js';
import { paginated, toSkipTake } from '../../lib/pagination.js';
import * as leads from './lead.repository.js';
import * as events from '../leadEvents/leadEvent.repository.js';
import * as followUps from '../followUps/followUp.repository.js';
import * as approvals from '../approvals/approval.repository.js';
import { allowedTransitions, canTransition, CLOSED_STATUSES } from './lead.status.js';
import { totalFromBreakdown } from './lead.scoring.js';
import { estimateDealValue } from '../revenue/dealValue.js';

/**
 * Business rules for leads. `ctx` is the authenticated tenant context
 * ({ businessId, userId, role }) and is the only source of `businessId`;
 * nothing tenant-related is ever read from the request body.
 */

const userActor = (ctx) => ({ type: 'USER', userId: ctx.userId });

function isNotFound(err) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

async function requireLead(ctx, id, db = prisma) {
  const lead = await leads.findById(ctx.businessId, id, db);
  if (!lead) throw new NotFoundError('Lead');
  return lead;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function list(ctx, query) {
  const { page, pageSize, ...filters } = query;
  const { rows, total } = await leads.findMany(ctx.businessId, filters, toSkipTake({ page, pageSize }));
  return paginated(rows, total, { page, pageSize });
}

/**
 * The 360-degree lead profile: lead, conversations, follow-ups, approvals,
 * appointments, assignee, deal value (with its basis) and the recommended
 * next action from the latest AI decision and open recommendations.
 */
export async function get(ctx, id) {
  const lead = await leads.findDetailById(ctx.businessId, id);
  if (!lead) throw new NotFoundError('Lead');
  const [services, appointments, decision, recommendations] = await Promise.all([
    prisma.service.findMany({ where: { businessId: ctx.businessId } }),
    prisma.appointment.findMany({ where: { businessId: ctx.businessId, leadId: id }, orderBy: { startsAt: 'desc' } }),
    prisma.leadEvent.findFirst({ where: { businessId: ctx.businessId, leadId: id, type: 'AGENT_DECISION' }, orderBy: { createdAt: 'desc' } }),
    prisma.recommendation.findMany({ where: { businessId: ctx.businessId, leadId: id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } }),
  ]);
  return {
    ...lead,
    allowedTransitions: allowedTransitions(lead.status),
    appointments,
    dealValue: estimateDealValue(lead, new Map(services.map((s) => [s.id, s]))),
    nextAction: decision ? { ...decision.data, decidedAt: decision.createdAt } : null,
    recommendations,
  };
}

export async function listEvents(ctx, id, { page, pageSize }) {
  await requireLead(ctx, id);
  const { rows, total } = await events.listForLead(ctx.businessId, id, toSkipTake({ page, pageSize }));
  return paginated(rows, total, { page, pageSize });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function create(ctx, input, actor = userActor(ctx)) {
  const now = new Date();
  const data = {
    name: input.name,
    email: input.email,
    phone: input.phone,
    company: input.company,
    source: input.source,
    lastContactAt: input.enquiry ? now : null,
    lastInboundAt: input.enquiry ? now : null,
    ...(input.consent?.email && {
      consentEmail: true,
      consentAt: now,
      consentSource: input.consent.source,
    }),
  };

  const lead = await prisma.$transaction(async (tx) => {
    const created = await leads.create(ctx.businessId, data, input.enquiry, tx);
    await events.record(
      {
        businessId: ctx.businessId,
        leadId: created.id,
        type: 'CREATED',
        actor,
        data: { source: created.source, hasEnquiry: Boolean(input.enquiry) },
      },
      tx,
    );
    if (input.enquiry) {
      await events.record(
        {
          businessId: ctx.businessId,
          leadId: created.id,
          type: 'MESSAGE_RECEIVED',
          actor: { type: 'LEAD' },
          data: { channel: input.enquiry.channel },
        },
        tx,
      );
    }
    return created;
  });

  return get(ctx, lead.id);
}

export async function update(ctx, id, input) {
  await prisma.$transaction(async (tx) => {
    const lead = await requireLead(ctx, id, tx);
    const data = {};

    for (const field of ['name', 'email', 'phone', 'company']) {
      if (input[field] !== undefined) data[field] = input[field];
    }
    const assignedBefore = lead.assignedToId;

    const email = data.email !== undefined ? data.email : lead.email;
    const phone = data.phone !== undefined ? data.phone : lead.phone;
    if (!email && !phone) {
      throw new UnprocessableError('LEAD_UNCONTACTABLE', 'A lead must keep at least an email or a phone number');
    }

    if (input.assignedToId !== undefined && input.assignedToId !== lead.assignedToId) {
      if (input.assignedToId) {
        const member = await tx.membership.findFirst({ where: { businessId: ctx.businessId, userId: input.assignedToId } });
        if (!member) throw new UnprocessableError('INVALID_ASSIGNEE', 'The assignee must be a member of this business');
      }
      data.assignedToId = input.assignedToId;
    }
    if (input.dealValueCents !== undefined) data.dealValueCents = input.dealValueCents;

    if (input.consent) {
      if (input.consent.email) {
        if (lead.status === 'OPTED_OUT') {
          throw new ConflictError('This lead opted out; consent can only be renewed by the lead');
        }
        if (!lead.consentEmail) {
          Object.assign(data, {
            consentEmail: true,
            consentAt: new Date(),
            consentSource: input.consent.source ?? 'dashboard:manual',
          });
        }
      } else {
        // Withdrawing consent stops all automated outreach immediately.
        data.consentEmail = false;
      }
    }

    const changed = Object.keys(data).filter((k) => k !== 'consentAt' && k !== 'consentSource');
    if (changed.length === 0) return;

    await leads.update(ctx.businessId, id, data, {}, tx);
    if (data.consentEmail === false && lead.consentEmail) {
      await followUps.cancelActiveForLead(ctx.businessId, id, 'Email consent withdrawn', tx);
    }
    // Field names only: values may be personal data and the timeline is long-lived.
    await events.record(
      { businessId: ctx.businessId, leadId: id, type: 'UPDATED', actor: userActor(ctx), data: { fields: changed } },
      tx,
    );
    if ('assignedToId' in data && data.assignedToId !== assignedBefore) {
      const assignee = data.assignedToId ? await tx.user.findUnique({ where: { id: data.assignedToId }, select: { name: true } }) : null;
      await events.record(
        { businessId: ctx.businessId, leadId: id, type: 'ASSIGNED', actor: userActor(ctx), data: { assignedToId: data.assignedToId, name: assignee?.name ?? null } },
        tx,
      );
    }
  });

  return get(ctx, id);
}

export async function changeStatus(ctx, id, { status, lostReason, note }, actor = userActor(ctx)) {
  const leadId = await prisma.$transaction(async (tx) => {
    const lead = await requireLead(ctx, id, tx);

    if (!canTransition(lead.status, status)) {
      throw new UnprocessableError(
        'INVALID_STATUS_TRANSITION',
        `Cannot move a lead from ${lead.status} to ${status}`,
        { from: lead.status, to: status, allowed: allowedTransitions(lead.status) },
      );
    }

    const now = new Date();
    const data = { status, lostReason: status === 'LOST' ? lostReason : null };
    if (status === 'OPTED_OUT') Object.assign(data, { consentEmail: false, optedOutAt: now });

    try {
      // Conditional on the status we read, so concurrent changes cannot both win.
      await leads.update(ctx.businessId, id, data, { expect: { status: lead.status } }, tx);
    } catch (err) {
      if (isNotFound(err)) throw new ConflictError('Lead was modified by someone else, please reload');
      throw err;
    }

    let cancelledFollowUps = 0;
    let expiredApprovals = 0;
    if (CLOSED_STATUSES.has(status)) {
      const reason = `Lead marked ${status}`;
      cancelledFollowUps = await followUps.cancelActiveForLead(ctx.businessId, id, reason, tx);
      expiredApprovals = await approvals.expirePendingForLead(ctx.businessId, id, reason, tx);
    }

    await events.record(
      {
        businessId: ctx.businessId,
        leadId: id,
        type: status === 'OPTED_OUT' ? 'OPTED_OUT' : 'STATUS_CHANGED',
        actor,
        data: {
          from: lead.status,
          to: status,
          ...(lostReason && { lostReason }),
          ...(note && { note }),
          ...(cancelledFollowUps && { cancelledFollowUps }),
          ...(expiredApprovals && { expiredApprovals }),
        },
      },
      tx,
    );
    if (cancelledFollowUps) {
      await events.record(
        {
          businessId: ctx.businessId,
          leadId: id,
          type: 'FOLLOW_UP_CANCELLED',
          actor: { type: 'SYSTEM' },
          data: { count: cancelledFollowUps, reason: `Lead marked ${status}` },
        },
        tx,
      );
    }
    return id;
  });

  return get(ctx, leadId);
}

export async function updateScore(ctx, id, input, actor = userActor(ctx)) {
  const scoredAt = new Date().toISOString();
  let score;
  let scoreBreakdown;

  if ('breakdown' in input) {
    const { urgency, budgetFit, conversionLikelihood, reasons } = input.breakdown;
    score = totalFromBreakdown(input.breakdown);
    scoreBreakdown = {
      urgency,
      budgetFit,
      conversionLikelihood,
      reasons,
      method: actor.type === 'AI' ? 'AI' : 'MANUAL',
      scoredAt,
    };
  } else {
    score = input.score;
    scoreBreakdown = { reasons: [input.reason], method: 'OVERRIDE', scoredAt };
  }

  await prisma.$transaction(async (tx) => {
    const lead = await requireLead(ctx, id, tx);
    await leads.update(ctx.businessId, id, { score, scoreBreakdown }, {}, tx);
    await events.record(
      {
        businessId: ctx.businessId,
        leadId: id,
        type: 'SCORE_UPDATED',
        actor,
        data: { from: lead.score, to: score, method: scoreBreakdown.method },
      },
      tx,
    );
  });

  return get(ctx, id);
}

export async function remove(ctx, id) {
  const deleted = await leads.remove(ctx.businessId, id);
  if (!deleted) throw new NotFoundError('Lead');
}
