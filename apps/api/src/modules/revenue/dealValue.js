import { formatCents } from '../../lib/money.js';

/**
 * Deal value for one lead, with the basis it came from. Order of preference:
 *   1. OWNER          value entered by the owner
 *   2. BUDGET         midpoint of the budget the lead stated
 *   3. SERVICE_PRICE  published prices of the matched services (range midpoint)
 * Returns { cents: null, source: null } when there is no factual basis:
 * the platform never guesses a number.
 */
export function estimateDealValue(lead, servicesById) {
  if (lead.dealValueCents != null) {
    return { cents: lead.dealValueCents, source: 'OWNER', basis: 'Entered by the owner' };
  }
  const budget = lead.qualification?.budget;
  if (budget?.stated && (budget.min != null || budget.max != null)) {
    const min = budget.min ?? budget.max;
    const max = budget.max ?? budget.min;
    const cents = Math.round(((min + max) / 2) * 100);
    const basis = min === max ? `Budget stated by the lead (${formatCents(min * 100)})` : `Midpoint of the stated budget (${formatCents(min * 100)}–${formatCents(max * 100)})`;
    return { cents, source: 'BUDGET', basis };
  }
  const matched = (lead.qualification?.matchedServiceIds ?? []).map((id) => servicesById.get(id)).filter(Boolean);
  const priced = matched.filter((s) => s.priceType !== 'QUOTE_ONLY' && s.priceMinCents != null);
  if (priced.length) {
    const cents = priced.reduce((sum, s) => sum + Math.round((s.priceMinCents + (s.priceMaxCents ?? s.priceMinCents)) / 2), 0);
    const names = priced.map((s) => s.name).join(', ');
    return { cents, source: 'SERVICE_PRICE', basis: `Published price of ${names}${priced.some((s) => s.priceType === 'RANGE') ? ' (range midpoint)' : ''}` };
  }
  if (matched.length) return { cents: null, source: null, basis: 'Matched services are quoted individually; no value until a quote is prepared' };
  return { cents: null, source: null, basis: 'No budget, matched service or owner value yet' };
}
