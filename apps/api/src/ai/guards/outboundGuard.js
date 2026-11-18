/**
 * Deterministic checks on AI-drafted customer messages. The model is told the
 * rules; this is what actually enforces them.
 *
 *  - every money amount must equal a published price of a referenced service
 *  - no discounts, free work, guarantees or other financial commitments
 *  - no concrete appointment times (availability is not known yet)
 */

const AMOUNT = /(?:US\$|\$|€|£|\b(?:USD|EUR|GBP)\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k\b)?/gi;
const WORD_AMOUNT = /\b(\d{1,3}(?:,\d{3})+|\d+)\s?(?:dollars|bucks|euros|pounds)\b/gi;

const COMMITMENT_PATTERNS = [
  { re: /\b\d{1,2}\s?%\s*(?:off|discount)|\bdiscount(?:ed|s)?\b|\bpercent off\b/i, why: 'mentions a discount' },
  { re: /\b(?:free of charge|for free|no charge|complimentary|waive[ds]?)\b/i, why: 'offers free or waived work' },
  { re: /\bguarantee(?:d|s)?\b|\bwe promise\b|\bI promise\b/i, why: 'makes a guarantee or promise' },
  { re: /\b(?:price match|beat (?:any|their) (?:price|quote))\b/i, why: 'offers price matching' },
  { re: /\b(?:deposit|refund)\b/i, why: 'mentions deposits or refunds' },
];

const AVAILABILITY_PATTERNS = [
  { re: /\b(?:[01]?\d)(?::[0-5]\d)?\s?(?:am|pm)\b/i, why: 'proposes a specific time' },
  {
    re: /\bwe (?:have|'ve got) (?:an? )?(?:opening|slot|availability|space)\b|\b(?:is|are) (?:available|open) on\b/i,
    why: 'claims specific availability',
  },
  { re: /\b(?:booked|confirmed) (?:you )?(?:in|for)\b/i, why: 'claims a booking was made' },
];

function toCents(whole, fraction, k) {
  const base = Number(whole.replace(/,/g, ''));
  const cents = Math.round(base * 100 + (fraction ? Number(fraction.padEnd(2, '0')) : 0));
  return k ? cents * 1000 : cents;
}

export function extractAmounts(text) {
  const amounts = [];
  for (const m of text.matchAll(AMOUNT)) amounts.push({ text: m[0].trim(), cents: toCents(m[1], m[2], m[3]) });
  for (const m of text.matchAll(WORD_AMOUNT)) amounts.push({ text: m[0].trim(), cents: toCents(m[1]) });
  return amounts;
}

/**
 * @param {string} text  subject + body of the draft
 * @param {Array} services  the referenced services (rows from `services`)
 * @returns {{ ok: boolean, violations: Array<{ rule: string, detail: string }> }}
 */
export function checkOutboundMessage(text, services) {
  const violations = [];
  const published = new Set();
  for (const s of services) {
    if (s.priceType === 'QUOTE_ONLY') continue;
    if (s.priceMinCents != null) published.add(s.priceMinCents);
    if (s.priceMaxCents != null) published.add(s.priceMaxCents);
  }

  for (const amount of extractAmounts(text)) {
    if (!published.has(amount.cents)) {
      violations.push({
        rule: 'UNPUBLISHED_PRICE',
        detail: `"${amount.text}" is not a published price of the services listed in referenced_service_ids.`,
      });
    }
  }
  for (const { re, why } of COMMITMENT_PATTERNS) {
    const m = text.match(re);
    if (m) violations.push({ rule: 'FINANCIAL_COMMITMENT', detail: `Draft ${why} ("${m[0]}"). Ask the owner instead.` });
  }
  for (const { re, why } of AVAILABILITY_PATTERNS) {
    const m = text.match(re);
    if (m) violations.push({ rule: 'UNVERIFIED_AVAILABILITY', detail: `Draft ${why} ("${m[0]}"). Ask for their preferred times instead.` });
  }
  return { ok: violations.length === 0, violations };
}
