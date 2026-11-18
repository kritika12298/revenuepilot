import { env } from '../config/env.js';

/** Strips characters that could inject extra headers. */
const headerSafe = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();

export function unsubscribeUrl(lead) {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/u/${lead.unsubscribeToken}`;
}

export function replyToAddress(lead, fallback) {
  return env.INBOUND_REPLY_ADDRESS ? env.INBOUND_REPLY_ADDRESS.replace('{token}', lead.replyToken) : fallback;
}

/**
 * Builds the provider-agnostic email for an approved message: sender identity,
 * reply routing, unsubscribe footer and RFC 8058 one-click headers.
 */
export function composeEmail({ business, lead, message, ownerEmail }) {
  const url = unsubscribeUrl(lead);
  const footer =
    `\n\n--\nYou are receiving this because you contacted ${business.name}. ` +
    `To stop receiving emails from us, unsubscribe here: ${url}`;
  return {
    from: `${headerSafe(business.name)} <${env.EMAIL_FROM_ADDRESS}>`,
    to: lead.email,
    replyTo: replyToAddress(lead, ownerEmail),
    subject: headerSafe(message.subject ?? `Your enquiry to ${business.name}`).slice(0, 200),
    text: `${message.body}${footer}`,
    headers: {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: [
      { name: 'business', value: business.id },
      { name: 'message', value: message.id },
    ],
    idempotencyKey: `msg-${message.id}`,
  };
}
