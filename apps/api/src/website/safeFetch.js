import http from 'node:http';
import https from 'node:https';
import { guardedLookup, UrlRejectedError, validatePublicUrl } from './netGuard.js';

export const USER_AGENT = 'RevenuePilotBot/1.0 (website analysis requested by the site owner)';
const DEFAULTS = { timeoutMs: 10_000, maxBytes: 1_500_000, maxRedirects: 3 };

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const sameSite = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

function requestOnce(url, { lookup, timeoutMs, maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: 'GET', lookup, timeout: timeoutMs, headers: { 'user-agent': USER_AGENT, accept: accept ?? 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new FetchError('TOO_LARGE', `Page is larger than ${Math.round(maxBytes / 1000)} kB`));
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new FetchError('TIMEOUT', 'The website took too long to respond')));
    // `timeout` above is an idle timeout; this is a hard deadline for the whole response
    // (a server dripping one byte at a time can't hold the worker).
    const deadline = setTimeout(() => req.destroy(new FetchError('TIMEOUT', 'The website took too long to respond')), timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', (err) => reject(err.code === 'EBLOCKED' ? new FetchError('BLOCKED_ADDRESS', err.message) : err instanceof FetchError ? err : new FetchError('NETWORK', err.message)));
    req.end();
  });
}

/**
 * Fetches a public web page with SSRF protection, redirect re-validation
 * (same site only), size and time limits and a content-type allowlist.
 * `lookup` is injectable for tests only.
 */
export function createSafeFetcher({ lookup = guardedLookup, ...limits } = {}) {
  const opts = { ...DEFAULTS, ...limits, lookup };
  async function fetchPage(rawUrl, { allowText = true, accept } = {}) {
    let url = validatePublicUrl(rawUrl);
    const startHost = url.hostname;
    for (let hop = 0; hop <= opts.maxRedirects; hop += 1) {
      const res = await requestOnce(url, { ...opts, accept });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        const next = validatePublicUrl(new URL(res.headers.location, url).href);
        if (!sameSite(next.hostname, startHost)) throw new FetchError('OFF_SITE_REDIRECT', `Redirect to another site (${next.hostname}) was not followed`);
        url = next;
        continue;
      }
      if (res.status !== 200) throw new FetchError('HTTP_STATUS', `The page returned HTTP ${res.status}`);
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      if (!type.includes('text/html') && !(allowText && type.includes('text/plain'))) {
        throw new FetchError('UNSUPPORTED_CONTENT', `Unsupported content type: ${type || 'unknown'}`);
      }
      return { url: url.href, body: res.body };
    }
    throw new FetchError('TOO_MANY_REDIRECTS', 'Too many redirects');
  }
  return { fetchPage };
}

export { UrlRejectedError };
