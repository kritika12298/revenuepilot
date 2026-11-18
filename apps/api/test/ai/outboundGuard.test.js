import { describe, expect, it } from 'vitest';
import { checkOutboundMessage, extractAmounts } from '../../src/ai/guards/outboundGuard.js';

const services = [
  { priceType: 'FIXED', priceMinCents: 15000, priceMaxCents: 15000 },
  { priceType: 'RANGE', priceMinCents: 4500, priceMaxCents: 8500 },
  { priceType: 'QUOTE_ONLY', priceMinCents: null, priceMaxCents: null },
];

describe('outbound message guard', () => {
  it('extracts amounts in common formats', () => {
    const cents = extractAmounts('From $45–$85, $1,200.50, USD 300, 12k? $12k, 40 dollars').map((a) => a.cents);
    expect(cents).toEqual([4500, 8500, 120050, 30000, 1200000, 4000]);
  });

  it('accepts published prices only', () => {
    expect(checkOutboundMessage('The consultation is $150 and maintenance is $45–$85 per visit.', services).ok).toBe(true);
    const bad = checkOutboundMessage('We can do it for $120.', services);
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]).toMatchObject({ rule: 'UNPUBLISHED_PRICE' });
  });

  it('does not accept prices of services that were not referenced', () => {
    expect(checkOutboundMessage('That is $150.', []).ok).toBe(false);
  });

  it.each([
    ['I can give you 10% off.', 'FINANCIAL_COMMITMENT'],
    ['We will waive the call-out fee.', 'FINANCIAL_COMMITMENT'],
    ['Results are guaranteed!', 'FINANCIAL_COMMITMENT'],
    ['We have an opening on Thursday.', 'UNVERIFIED_AVAILABILITY'],
    ['How about Tuesday at 10am?', 'UNVERIFIED_AVAILABILITY'],
  ])('blocks commitments: %s', (body, rule) => {
    const result = checkOutboundMessage(body, services);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain(rule);
  });

  it('allows ordinary qualification questions', () => {
    const body = 'Hi Sam, thanks for reaching out! What days usually suit you, and roughly how big is the yard?';
    expect(checkOutboundMessage(body, services)).toEqual({ ok: true, violations: [] });
  });
});
