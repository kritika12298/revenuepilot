const nf = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const formatNumber = (n) => (n == null ? '–' : n >= 10_000 ? compact.format(n) : nf.format(n));
export const formatPercent = (n) => (n == null ? '–' : `${n % 1 === 0 ? n : n.toFixed(1)}%`);

export function formatMoney(cents, currency = 'USD') {
  if (cents == null) return '–';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

export function formatServicePrice(s) {
  if (s.priceType === 'QUOTE_ONLY') return 'Quote only';
  if (s.priceType === 'FIXED') return formatMoney(s.priceMinCents, s.currency);
  return `${formatMoney(s.priceMinCents, s.currency)}–${formatMoney(s.priceMaxCents, s.currency)}`;
}

export function formatDuration(minutes) {
  if (minutes == null) return '–';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 48) return m ? `${h}h ${m}m` : `${h}h`;
  return `${Math.round(h / 24)} days`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

export function relativeTime(date, now = Date.now()) {
  if (!date) return '–';
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (abs >= size || unit === 'minute') return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export function formatDateTime(date, timeZone) {
  if (!date) return '–';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(date));
}

export function formatDate(date, timeZone) {
  if (!date) return '–';
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));
}

/** "2026-11-18" -> "Nov 18" without time-zone shifting. */
export function formatDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
}

export const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

export const titleCase = (s = '') => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
