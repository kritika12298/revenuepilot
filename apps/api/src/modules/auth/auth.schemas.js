import { z } from 'zod';
import { timezone } from '../../lib/validators.js';

export const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email('Invalid email address'));

// bcrypt only uses the first 72 bytes, so cap the length there.
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(72, 'Password must be at most 72 characters');

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: emailField,
  password,
  businessName: z.string().trim().min(2).max(120),
  timezone: timezone.default('UTC'),
});

export const loginSchema = z.strictObject({
  email: emailField,
  password: z.string().min(1).max(72),
  businessId: z.uuid().optional(),
});

export const switchBusinessSchema = z.strictObject({
  businessId: z.uuid(),
});
