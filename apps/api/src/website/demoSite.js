import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Bundled demo website, served only for reserved ".test" hostnames when
 * DEMO_MODE is on, so the hackathon demo works offline. Real hostnames always
 * go through the SSRF-guarded network fetcher.
 */
export const DEMO_HOSTS = ['evergreen-landscaping.test', 'www.evergreen-landscaping.test'];
const DIR = fileURLToPath(new URL('../../demo/website/', import.meta.url));
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/services': 'services.html', '/faq': 'faq.html', '/contact': 'contact.html', '/robots.txt': 'robots.txt' };

export function isDemoHost(url) {
  return DEMO_HOSTS.includes(new URL(url).hostname.toLowerCase());
}

export async function fetchDemoPage(rawUrl) {
  const url = new URL(rawUrl);
  const file = PAGES[url.pathname.replace(/\/$/, '') || '/'];
  if (!file) {
    const err = new Error('The page returned HTTP 404');
    err.code = 'HTTP_STATUS';
    throw err;
  }
  return { url: url.href, body: await readFile(DIR + file, 'utf8') };
}
