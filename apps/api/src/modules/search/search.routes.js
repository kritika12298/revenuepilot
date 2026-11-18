import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { prisma } from '../../lib/prisma.js';

/** GET /api/search?q=: leads (name, email, company, phone) and conversation messages, scoped to the business. */
export const searchRouter = Router();
searchRouter.use(authenticate);
searchRouter.get('/', validate({ query: z.strictObject({ q: z.string().trim().min(2).max(100) }) }), async (req, res) => {
  const { q } = req.valid.query;
  const contains = { contains: q, mode: 'insensitive' };
  const [leads, messages] = await Promise.all([
    prisma.lead.findMany({
      where: { businessId: req.auth.businessId, OR: [{ name: contains }, { email: contains }, { company: contains }, { phone: contains }] },
      select: { id: true, name: true, email: true, company: true, status: true, score: true },
      orderBy: { updatedAt: 'desc' },
      take: 8,
    }),
    prisma.message.findMany({
      where: { businessId: req.auth.businessId, body: contains },
      select: { id: true, body: true, direction: true, createdAt: true, conversation: { select: { lead: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);
  const snippet = (body) => {
    const i = body.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, i - 40);
    return `${start ? '…' : ''}${body.slice(start, start + 120)}${start + 120 < body.length ? '…' : ''}`;
  };
  res.json({
    leads,
    messages: messages.map((m) => ({ id: m.id, lead: m.conversation.lead, snippet: snippet(m.body), direction: m.direction, createdAt: m.createdAt })),
  });
});
