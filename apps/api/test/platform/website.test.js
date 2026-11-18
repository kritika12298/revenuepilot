import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/lib/prisma.js';
import { setAIClient } from '../../src/ai/client.js';
import { guardedLookup, isPublicAddress, validatePublicUrl } from '../../src/website/netGuard.js';
import { createSafeFetcher } from '../../src/website/safeFetch.js';
import { crawlSite } from '../../src/website/crawler.js';
import { processAnalyzeWebsite } from '../../src/jobs/analyzeWebsite.js';
import { searchBusinessKnowledge } from '../../src/ai/tools/websiteTools.js';
import { addMember, api, auth, registerOwner } from '../helpers.js';
import { scriptedClient, text, toolResultsIn, toolUse } from '../ai/scripted.js';

const DEMO = 'https://evergreen-landscaping.test/';

describe('SSRF protection', () => {
  it.each([
    ['8.8.8.8', true],
    ['93.184.216.34', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.20.0.5', false],
    ['192.168.1.10', false],
    ['169.254.169.254', false], // cloud metadata
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['::7f00:1', false],
    ['fec0::1', false],
    ['2606:4700:4700::1111', true],
    ['fe80::1', false],
    ['fd00::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:10.0.0.1', false],
    ['not-an-ip', false],
  ])('isPublicAddress(%s) = %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each([
    ['ftp://example.com', /http and https/],
    ['http://user:pass@example.com', /credentials/],
    ['http://example.com:8080/', /standard web ports/],
    ['http://localhost/', /public website/],
    ['http://intranet/', /public website/],
    ['http://printer.local/', /internal/],
    ['http://127.0.0.1/', /IP addresses/],
    ['http://[::1]/', /IP addresses/],
    ['http://169.254.169.254/latest/meta-data', /IP addresses/],
    ['not a url', /full website address/],
  ])('rejects %s', (url, message) => {
    expect(() => validatePublicUrl(url)).toThrow(message);
  });

  it('accepts normal public URLs and strips fragments', () => {
    expect(validatePublicUrl('https://www.example.com/services#top').href).toBe('https://www.example.com/services');
  });

  it('refuses DNS answers that point at private addresses (checked at connect time)', async () => {
    const err = await new Promise((resolve) => guardedLookup('localhost', {}, (e) => resolve(e)));
    expect(err.code).toBe('EBLOCKED');
  });
});

describe('safe fetcher limits', () => {
  let server;
  let port;
  // Test-only lookup that maps any host to the local test server, so limits
  // can be exercised without the internet (production uses guardedLookup).
  const toLocal = (_h, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/big') return res.writeHead(200, { 'content-type': 'text/html' }), res.end('x'.repeat(5000));
      if (req.url === '/pdf') return res.writeHead(200, { 'content-type': 'application/pdf' }), res.end('%PDF');
      if (req.url === '/away') return res.writeHead(302, { location: 'http://evil.example/' }), res.end();
      if (req.url === '/inside') return res.writeHead(301, { location: '/ok' }), res.end();
      if (req.url === '/meta') return res.writeHead(302, { location: 'http://169.254.169.254/' }), res.end();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><title>OK</title><body>fine</body></html>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  // Port 80 is required by validation, so route via a fetcher whose request goes to the test port.
  const fetcher = () => {
    const f = createSafeFetcher({ lookup: toLocal, maxBytes: 1000 });
    return (path) => f.fetchPage(`http://site.example${path}`.replace('site.example', `site.example`)).catch((e) => e);
  };

  it('enforces size, content type and same-site redirects', async () => {
    // Re-point the default port to the test server for this suite.
    const { default: httpMod } = await import('node:http');
    const original = httpMod.request;
    httpMod.request = (url, opts, cb) => original({ ...opts, host: '127.0.0.1', port, path: url.pathname + url.search, lookup: undefined }, cb);
    try {
      const get = fetcher();
      expect((await get('/ok')).body).toContain('fine');
      expect(await get('/big')).toMatchObject({ code: 'TOO_LARGE' });
      expect(await get('/pdf')).toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
      expect(await get('/away')).toMatchObject({ code: 'OFF_SITE_REDIRECT' });
      expect(await get('/meta')).toMatchObject({ code: 'URL_REJECTED' });
      expect((await get('/inside')).url).toBe('http://site.example/ok');
    } finally {
      httpMod.request = original;
    }
  });
});

describe('crawler', () => {
  it('crawls the bundled demo site, prioritising service, pricing and FAQ pages', async () => {
    const { pages, demo } = await crawlSite(DEMO);
    expect(demo).toBe(true);
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/services', '/faq', '/contact']);
    const services = pages.find((p) => p.url.endsWith('/services'));
    expect(services.sections.map((s) => s.heading)).toContain('Lawn maintenance');
    expect(services.text).toContain('$45 to $85 per visit');
  });

  it('stops at the request budget even when every link fails (failed fetches count)', async () => {
    let calls = 0;
    const links = Array.from({ length: 5000 }, (_, i) => `<a href="/broken-${i}">x</a>`).join('');
    const fetcher = async (url) => {
      calls += 1;
      if (url.endsWith('/robots.txt')) throw new Error('none');
      if (url === 'https://site.example/') return { url, body: `<html><body><h1>Home</h1>${links}</body></html>` };
      throw new Error('404');
    };
    const { pages, errors } = await crawlSite('https://site.example/', { fetcher, maxRequests: 20 });
    expect(pages).toHaveLength(1);
    expect(calls).toBeLessThanOrEqual(20);
    expect(errors.at(-1)).toMatchObject({ code: 'BUDGET' });
  });
});

describe('website intelligence', () => {
  async function connect(owner, url = DEMO) {
    const res = await api().post('/api/website').set(auth(owner.token)).send({ url });
    return res;
  }

  it('connects a website, extracts verifiable knowledge for review, and lists what is missing', async () => {
    const owner = await registerOwner();
    const res = await connect(owner);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'QUEUED', url: DEMO });

    const result = await processAnalyzeWebsite({ data: { businessId: owner.businessId, requestedBy: owner.userId }, attemptsMade: 0, opts: { attempts: 2 } });
    expect(result.outcome).toBe('COMPLETED');

    const site = await api().get('/api/website').set(auth(owner.token));
    expect(site.body.website).toMatchObject({ status: 'COMPLETED', pagesFetched: 4 });
    expect(site.body.website.summary).toMatch(/Family-owned landscaping/);
    expect(site.body.website.missingInfo).toEqual([]);

    const items = (await api().get('/api/knowledge').set(auth(owner.token))).body.data;
    expect(items.every((i) => i.status === 'PENDING_REVIEW' && i.source === 'WEBSITE')).toBe(true);
    const lawn = items.find((i) => i.title === 'Lawn maintenance');
    expect(lawn).toMatchObject({ type: 'SERVICE', priceText: 'Weekly lawn maintenance costs $45 to $85 per visit depending on lot size.' });
    expect(items.find((i) => i.title === 'Landscape installation').priceText).toBeNull();
    expect(items.filter((i) => i.type === 'FAQ')).toHaveLength(4);
    expect(items.some((i) => i.type === 'BUSINESS_INFO' && /Monday to Friday/.test(i.content))).toBe(true);

    const run = await prisma.agentRun.findFirst({ where: { businessId: owner.businessId, kind: 'WEBSITE_ANALYSIS' } });
    expect(run).toMatchObject({ status: 'SUCCEEDED', triggerDetail: expect.stringContaining('bundled demo site') });
    expect(await prisma.notification.count({ where: { businessId: owner.businessId, reason: 'WEBSITE_ANALYSIS' } })).toBe(1);
  });

  it('rejects extractions with invented prices or quotes that are not on the page', async () => {
    const owner = await registerOwner();
    await connect(owner);
    const ai = scriptedClient([
      () => [toolUse('get_website_pages', {})],
      () => [
        toolUse('record_business_knowledge', {
          business_summary: 'A landscaping company in Denver.',
          services: [{ name: 'Lawn maintenance', description: 'Weekly mowing.', price_text: 'From $39 per visit', source_url: `${DEMO}services`, evidence: 'Weekly mowing, edging, blowing and weed control' }],
          faqs: [],
          business_info: [{ type: 'POLICY', title: 'Discounts', content: '10% off for seniors', source_url: `${DEMO}faq`, evidence: 'Seniors get 10% off' }],
        }),
      ],
      () => [
        toolUse('record_business_knowledge', {
          business_summary: 'A landscaping company in Denver.',
          services: [{ name: 'Lawn maintenance', description: 'Weekly mowing.', price_text: null, source_url: `${DEMO}services`, evidence: 'Weekly mowing, edging, blowing and weed control' }],
          faqs: [],
          business_info: [],
        }),
      ],
      () => [text('Done')],
    ]);
    setAIClient(ai);
    await processAnalyzeWebsite({ data: { businessId: owner.businessId, requestedBy: owner.userId }, attemptsMade: 0, opts: { attempts: 2 } });
    const problems = toolResultsIn(ai.requests[2])[0].payload;
    expect(problems.error).toBe('UNVERIFIED_CONTENT');
    expect(problems.details.map((d) => d.problem)).toEqual(
      expect.arrayContaining(['price_text does not appear on the page; use null if no price is stated', 'evidence is not a word-for-word quote from the page']),
    );
    const items = await prisma.knowledgeItem.findMany({ where: { businessId: owner.businessId } });
    expect(items.map((i) => [i.title, i.priceText])).toEqual([['Lawn maintenance', null]]);
  });

  it('validates the website URL and restricts it to owners', async () => {
    const owner = await registerOwner();
    const member = await addMember(owner.businessId);
    const bad = await connect(owner, 'http://169.254.169.254/latest/meta-data');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_WEBSITE_URL');
    expect((await api().post('/api/website').set(auth(member.token)).send({ url: DEMO })).status).toBe(403);
  });

  it('only owner-approved knowledge reaches the AI, and owners can promote services with explicit prices', async () => {
    const owner = await registerOwner();
    await connect(owner);
    await processAnalyzeWebsite({ data: { businessId: owner.businessId, requestedBy: owner.userId }, attemptsMade: 0, opts: { attempts: 2 } });
    const items = (await api().get('/api/knowledge').set(auth(owner.token))).body.data;
    const faq = items.find((i) => i.title === 'How soon can you start?');
    const runCtx = { businessId: owner.businessId, state: {} };

    expect((await searchBusinessKnowledge.handler({ query: 'how soon start' }, runCtx)).results).toEqual([]);
    const approved = await api().patch(`/api/knowledge/${faq.id}`).set(auth(owner.token)).send({ status: 'APPROVED' });
    expect(approved.body).toMatchObject({ status: 'APPROVED', reviewedById: owner.userId });
    const found = await searchBusinessKnowledge.handler({ query: 'how soon can you start' }, runCtx);
    expect(found.results[0]).toMatchObject({ title: 'How soon can you start?', source: 'website (owner-approved)' });

    const lawn = items.find((i) => i.title === 'Lawn maintenance');
    const svc = await api().post(`/api/knowledge/${lawn.id}/promote`).set(auth(owner.token)).send({ priceType: 'RANGE', priceMinCents: 4500, priceMaxCents: 8500 });
    expect(svc.status).toBe(201);
    expect(svc.body).toMatchObject({ name: 'Lawn maintenance', priceMinCents: 4500, priceMaxCents: 8500 });
    expect((await prisma.auditLog.findMany({ where: { businessId: owner.businessId } })).map((a) => a.action)).toEqual(
      expect.arrayContaining(['website.analysis_requested', 'knowledge.approved', 'knowledge.promoted_to_service']),
    );

    // Re-syncing keeps owner decisions and does not resurrect rejected items.
    const install = items.find((i) => i.title === 'Landscape installation');
    await api().patch(`/api/knowledge/${install.id}`).set(auth(owner.token)).send({ status: 'REJECTED' });
    await processAnalyzeWebsite({ data: { businessId: owner.businessId, requestedBy: owner.userId }, attemptsMade: 0, opts: { attempts: 2 } });
    const after = await prisma.knowledgeItem.findMany({ where: { businessId: owner.businessId, title: { in: ['Landscape installation', 'How soon can you start?'] } } });
    expect(after.map((i) => i.status).sort()).toEqual(['APPROVED', 'REJECTED']);

    const other = await registerOwner();
    expect((await api().get('/api/knowledge').set(auth(other.token))).body.data).toEqual([]);
    expect((await api().patch(`/api/knowledge/${faq.id}`).set(auth(other.token)).send({ status: 'REJECTED' })).status).toBe(404);
  });
});
