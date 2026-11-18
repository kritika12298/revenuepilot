/**
 * GoDaddy Domains API (v1), per developer.godaddy.com OpenAPI spec:
 *   GET https://api.godaddy.com/v1/domains   (Authorization: Bearer <Personal Access Token>)
 *   query: statuses, limit, marker; items: domain, domainId, status, expires, renewAuto
 * Rate limit: 60 requests/minute per credential.
 */
export class GoDaddyError extends Error {
  constructor(message, status) {
    super(message);
    this.code = 'GODADDY_ERROR';
    this.status = status;
  }
}

export function createGoDaddyClient({ token, baseUrl = 'https://api.godaddy.com', fetch = globalThis.fetch }) {
  return {
    async listDomains() {
      const res = await fetch(`${baseUrl}/v1/domains?statuses=ACTIVE&limit=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const hint = res.status === 401 ? 'the token is invalid or expired' : res.status === 403 ? 'the token lacks domains.domain:read or the account is not eligible for API access' : body?.message ?? res.statusText;
        throw new GoDaddyError(`GoDaddy API ${res.status}: ${hint}`, res.status);
      }
      return (Array.isArray(body) ? body : []).map((d) => ({ domain: d.domain, domainId: d.domainId, status: d.status, expires: d.expires, renewAuto: d.renewAuto }));
    },
  };
}
