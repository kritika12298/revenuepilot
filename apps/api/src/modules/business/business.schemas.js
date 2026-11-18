import { z } from 'zod';
import { timezone } from '../../lib/validators.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)');

const interval = z
  .strictObject({ open: hhmm, close: hhmm })
  .refine((i) => i.open < i.close, 'open must be before close');

const day = z.array(interval).max(4);

export const workingHoursSchema = z.strictObject({
  mon: day.optional(),
  tue: day.optional(),
  wed: day.optional(),
  thu: day.optional(),
  fri: day.optional(),
  sat: day.optional(),
  sun: day.optional(),
});

export const commsPrefsSchema = z.strictObject({
  tone: z.enum(['friendly', 'professional', 'concise']).optional(),
  signature: z.string().trim().max(500).optional(),
  maxFollowUps: z.number().int().min(0).max(5).optional(),
  /** Hours after the previous touch for each follow-up step. */
  followUpCadenceHours: z.array(z.number().int().min(1).max(24 * 30)).max(5).optional(),
  channels: z.array(z.enum(['EMAIL'])).min(1).optional(),
  /** Master switch for automated follow-ups (default on). */
  followUpsEnabled: z.boolean().optional(),
  /** Send AI follow-up drafts without owner review (default off). */
  autoApproveFollowUps: z.boolean().optional(),
});

export const updateBusinessSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120).optional(),
    timezone: timezone.optional(),
    workingHours: workingHoursSchema.optional(),
    commsPrefs: commsPrefsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update')
  .refine(
    (v) => !v.commsPrefs?.followUpCadenceHours || !v.commsPrefs.maxFollowUps || v.commsPrefs.followUpCadenceHours.length >= 1,
    'followUpCadenceHours needs at least one delay',
  );

const cents = z.number().int().min(0).max(100_000_000);

export const serviceSchema = z
  .strictObject({
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    priceType: z.enum(['FIXED', 'RANGE', 'QUOTE_ONLY']),
    priceMinCents: cents.nullable().optional(),
    priceMaxCents: cents.nullable().optional(),
    currency: z.string().trim().toUpperCase().length(3).default('USD'),
    durationMinutes: z.number().int().min(5).max(24 * 60).nullable().optional(),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.priceType === 'FIXED' && v.priceMinCents == null) {
      ctx.addIssue({ code: 'custom', path: ['priceMinCents'], message: 'A fixed price needs an amount' });
    }
    if (v.priceType === 'RANGE') {
      if (v.priceMinCents == null || v.priceMaxCents == null) {
        ctx.addIssue({ code: 'custom', path: ['priceMaxCents'], message: 'A price range needs a minimum and a maximum' });
      } else if (v.priceMinCents > v.priceMaxCents) {
        ctx.addIssue({ code: 'custom', path: ['priceMaxCents'], message: 'Maximum must be at least the minimum' });
      }
    }
  })
  // Normalise so stored prices always match the price type.
  .transform((v) => ({
    ...v,
    priceMinCents: v.priceType === 'QUOTE_ONLY' ? null : v.priceMinCents,
    priceMaxCents: v.priceType === 'QUOTE_ONLY' ? null : v.priceType === 'FIXED' ? v.priceMinCents : v.priceMaxCents,
  }));
