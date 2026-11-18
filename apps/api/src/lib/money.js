/** Formats integer cents for humans, dropping ".00" on whole amounts. */
export function formatCents(cents, currency = 'USD') {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** Human-readable price for a Service row. Never invents a number. */
export function describeServicePrice(service) {
  switch (service.priceType) {
    case 'FIXED':
      return formatCents(service.priceMinCents, service.currency);
    case 'RANGE':
      return `${formatCents(service.priceMinCents, service.currency)}–${formatCents(service.priceMaxCents, service.currency)}`;
    default:
      return 'Quoted individually by the owner (no published price)';
  }
}
