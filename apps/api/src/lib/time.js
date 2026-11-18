/** "Thu, Nov 20 at 10:00 AM (America/Denver)" in the business's time zone. */
export function formatDateTimeIn(date, timeZone) {
  const text = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date));
  return `${text.replace(/, (\d+:\d+)/, ' at $1')} (${timeZone})`;
}
