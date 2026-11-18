/** Verifies a Resend API key by listing sending domains (GET https://api.resend.com/domains). */
export async function checkResend({ apiKey, fetch = globalThis.fetch }) {
  const res = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body.message ?? body.name ?? res.statusText}`);
  const domains = Array.isArray(body.data) ? body.data : [];
  return { domains: domains.map((d) => ({ name: d.name, status: d.status })) };
}
