import { env } from '../config/env.js';
import { createMockEmailProvider } from './providers/mock.js';
import { createResendProvider } from './providers/resend.js';

let provider = null;

/** The configured email provider (EMAIL_PROVIDER=mock|resend). */
export function getEmailProvider() {
  if (!provider) {
    provider = env.EMAIL_PROVIDER === 'resend' ? createResendProvider({ apiKey: env.RESEND_API_KEY }) : createMockEmailProvider();
  }
  return provider;
}

/** Test hook. Pass null to reset to the configured provider. */
export function setEmailProvider(next) {
  provider = next;
}
