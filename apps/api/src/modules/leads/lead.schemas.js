import { z } from 'zod';
import { emailField } from '../auth/auth.schemas.js';
import { pagination } from '../../lib/validators.js';
import { LEAD_STATUSES, LOST_REASONS } from './lead.status.js';
import { SCORE_WEIGHTS } from './lead.scoring.js';

const LEAD_SOURCES = ['WEB_FORM', 'EMAIL', 'API', 'MANUAL'];
const CHANNELS = ['EMAIL', 'WEB_FORM', 'SMS', 'PHONE'];

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,24}$/, 'Invalid phone number');

const optionalText = (max) => z.string().trim().min(1).max(max);

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

export const createLeadSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    email: emailField.optional(),
    phone: phone.optional(),
    company: optionalText(200).optional(),
    source: z.enum(LEAD_SOURCES).default('MANUAL'),
    enquiry: z
      .strictObject({
        channel: z.enum(CHANNELS).default('EMAIL'),
        subject: optionalText(300).optional(),
        message: z.string().trim().min(1).max(5000),
      })
      .optional(),
    consent: z
      .strictObject({
        email: z.boolean(),
        source: optionalText(200),
      })
      .optional(),
  })
  .refine((v) => v.email || v.phone, {
    message: 'Provide at least an email or a phone number',
    path: ['email'],
  });

export const updateLeadSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    email: emailField.nullable().optional(),
    phone: phone.nullable().optional(),
    company: optionalText(200).nullable().optional(),
    consent: z
      .strictObject({
        email: z.boolean(),
        source: optionalText(200).optional(),
      })
      .optional(),
    assignedToId: z.uuid().nullable().optional(),
    /** Owner-entered deal value in cents; null clears it (falls back to the estimate). */
    dealValueCents: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

// ---------------------------------------------------------------------------
// Status and score
// ---------------------------------------------------------------------------

export const updateStatusSchema = z
  .strictObject({
    status: z.enum(LEAD_STATUSES),
    lostReason: z.enum(LOST_REASONS).optional(),
    note: optionalText(1000).optional(),
  })
  .refine((v) => v.status !== 'LOST' || v.lostReason, {
    message: 'lostReason is required when marking a lead as LOST',
    path: ['lostReason'],
  })
  .refine((v) => v.status === 'LOST' || !v.lostReason, {
    message: 'lostReason is only allowed when status is LOST',
    path: ['lostReason'],
  });

const reasons = z.array(z.string().trim().min(1).max(300)).min(1).max(10);

/** Component scores; the total is computed server-side. */
const breakdownScore = z.strictObject({
  breakdown: z.strictObject({
    urgency: z.number().int().min(0).max(SCORE_WEIGHTS.urgency),
    budgetFit: z.number().int().min(0).max(SCORE_WEIGHTS.budgetFit),
    conversionLikelihood: z.number().int().min(0).max(SCORE_WEIGHTS.conversionLikelihood),
    reasons,
  }),
});

/** Owner override of the total, with a mandatory reason. */
const overrideScore = z.strictObject({
  score: z.number().int().min(0).max(100),
  reason: z.string().trim().min(1).max(300),
});

export const updateScoreSchema = z.union([breakdownScore, overrideScore], {
  error: 'Provide either { breakdown } or { score, reason }',
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const csvEnum = (values) =>
  z
    .string()
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

export const listLeadsQuerySchema = z
  .strictObject({
    ...pagination,
    status: csvEnum(LEAD_STATUSES).optional(),
    source: csvEnum(LEAD_SOURCES).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    maxScore: z.coerce.number().int().min(0).max(100).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(['createdAt', 'updatedAt', 'score', 'name']).default('createdAt'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((v) => v.minScore === undefined || v.maxScore === undefined || v.minScore <= v.maxScore, {
    message: 'minScore must be less than or equal to maxScore',
    path: ['minScore'],
  });

export const listEventsQuerySchema = z.strictObject({ ...pagination });
