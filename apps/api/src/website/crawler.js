import { parse } from 'node-html-parser';
import { env } from '../config/env.js';
import { createSafeFetcher } from './safeFetch.js';
import { fetchDemoPage, isDemoHost } from './demoSite.js';

const PRIORITY = /servic|pric|rate|faq|question|about|contact|area|location|hours|book|quote|package/i;
const SKIP = /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|css|js|ico|xml|json)(\?|$)/i;
const MAX_TEXT = 12_000;

const clean = (s) => s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** Title, description, text, heading sections and same-site links of one page. */
export function parsePage(html, pageUrl) {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  root.querySelectorAll('script,style,noscript,svg,iframe,template').forEach((n) => n.remove());
  const title = clean(root.querySelector('title')?.text ?? '');
  const description = root.querySelector('meta[name="description"]')?.getAttribute('content') ?? null;
  const body = root.querySelector('body') ?? root;

  const sections = [];
  for (const h of body.querySelectorAll('h1,h2,h3')) {
    const parts = [];
    let node = h.nextElementSibling;
    while (node && !/^H[1-3]$/.test(node.tagName)) {
      parts.push(node.structuredText ?? node.text);
      node = node.nextElementSibling;
    }
    sections.push({ heading: clean(h.text), text: clean(parts.join('\n')).slice(0, 1500) });
  }

  const base = new URL(pageUrl);
  const links = new Set();
  for (const a of body.querySelectorAll('a')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
    try {
      const u = new URL(href, base);
      u.hash = '';
      if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '') && /^https?:$/.test(u.protocol) && !SKIP.test(u.pathname)) links.add(u.href);
    } catch {
      /* ignore malformed links */
    }
  }
  return { url: pageUrl, title, description, text: clean(body.structuredText ?? body.text).slice(0, MAX_TEXT), sections, links: [...links] };
}

function robotsRules(txt) {
  const disallow = [];
  let applies = false;
  for (const line of txt.split('\n')) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') applies = value === '*' || /revenuepilot/i.test(value);
    else if (applies && key === 'disallow' && value) disallow.push(value);
  }
  return disallow;
}

/**
 * Crawls a site breadth-first, same site only, favouring pages likely to
 * describe services, prices, FAQs and contact details. Respects robots.txt.
 */
export async function crawlSite(startUrl, { maxPages = 8, maxRequests = 20, maxDurationMs = 60_000, maxLinksPerPage = 50, fetcher } = {}) {
  const demo = env.DEMO_MODE && isDemoHost(startUrl);
  const fetchPage = fetcher ?? (demo ? fetchDemoPage : createSafeFetcher().fetchPage);
  const origin = new URL(startUrl).origin;

  let disallow = [];
  try {
    disallow = robotsRules((await fetchPage(`${origin}/robots.txt`, { accept: 'text/plain' })).body);
  } catch {
    /* no robots.txt: everything allowed */
  }
  const allowed = (u) => !disallow.some((rule) => new URL(u).pathname.startsWith(rule));

  const queue = [startUrl];
  const seen = new Set(queue);
  const pages = [];
  const errors = [];
  // Hard budgets: failed fetches count too, so a page full of broken links can't
  // turn one analysis into thousands of requests or hold the worker indefinitely.
  const started = Date.now();
  let requests = 1; // robots.txt
  while (queue.length && pages.length < maxPages) {
    if (requests >= maxRequests || Date.now() - started > maxDurationMs) {
      errors.push({ url: queue[0], error: 'Crawl budget reached', code: 'BUDGET' });
      break;
    }
    const url = queue.shift();
    if (!allowed(url)) {
      errors.push({ url, error: 'Disallowed by robots.txt' });
      continue;
    }
    try {
      requests += 1;
      const res = await fetchPage(url);
      const page = parsePage(res.body, res.url);
      pages.push(page);
      const next = page.links
        .filter((l) => !seen.has(l))
        .sort((a, b) => Number(PRIORITY.test(b)) - Number(PRIORITY.test(a)))
        .slice(0, maxLinksPerPage);
      for (const l of next) {
        seen.add(l);
        queue.push(l);
      }
    } catch (err) {
      errors.push({ url, error: err.message, code: err.code });
      if (pages.length === 0 && url === startUrl) break; // the site itself is unreachable
    }
  }
  return { pages, errors, demo };
}
