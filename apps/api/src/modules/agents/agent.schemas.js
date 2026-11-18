import { z } from 'zod';
import { pagination } from '../../lib/validators.js';
import { CONVERSATION_GOALS } from '../../ai/agents/conversation.js';

export const startRunSchema = z
  .strictObject({
    agent: z.enum(['orchestrator', 'lead_intelligence', 'conversation']).default('orchestrator'),
    // FOLLOW_UP drafts are created only by scheduled follow-up jobs (POST /api/leads/:id/follow-ups).
    goal: z.enum(CONVERSATION_GOALS.filter((g) => g !== 'FOLLOW_UP')).optional(),
    reason: z.string().trim().min(3).max(300).optional(),
  })
  .refine((v) => !v.goal || v.agent === 'conversation', {
    message: 'goal only applies to the conversation agent',
    path: ['goal'],
  });

export const listRunsQuerySchema = z.strictObject({ ...pagination });
