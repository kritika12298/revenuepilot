import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { defineTool, ToolPolicyError } from './define.js';

/** Whitespace/case-insensitive comparison so verbatim checks survive HTML formatting. */
export const normalise = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/[’‘]/g, "'").replace(/[–—]/g, '-').trim();

export const getWebsitePages = defineTool({
  name: 'get_website_pages',
  description: "Return the text of the business's website pages that were crawled (title, URL, headings and text).",
  access: 'read',
  scope: 'business',
  input: z.strictObject({}),
  async handler(_input, runCtx) {
    return {
      pages: runCtx.state.pages.map((p) => ({
        url: p.url,
        title: p.title,
        description: p.description,
        sections: p.sections.slice(0, 40),
        text: p.text.slice(0, 6000),
      })),
    };
  },
});

const verbatim = (max) => z.string().trim().min(3).max(max);
const sourced = { source_url: z.string().url().describe('The page URL this came from.'), evidence: verbatim(300).describe('A short quote copied word for word from that page.') };

export const recordBusinessKnowledge = defineTool({
  name: 'record_business_knowledge',
  description:
    'Save what the website says. Every item needs the page URL and an evidence quote copied word for word from that page. ' +
    'price_text must also be copied word for word, or null. Never infer a price, discount, availability or policy that is not stated.',
  access: 'write',
  scope: 'business',
  input: z.strictObject({
    business_summary: z.string().trim().min(10).max(600),
    services: z
      .array(z.strictObject({ name: z.string().trim().min(2).max(120), description: z.string().trim().min(5).max(500), price_text: verbatim(200).nullable(), ...sourced }))
      .max(25),
    faqs: z.array(z.strictObject({ question: z.string().trim().min(5).max(300), answer: z.string().trim().min(2).max(800), ...sourced })).max(30),
    business_info: z
      .array(
        z.strictObject({
          type: z.enum(['BUSINESS_INFO', 'CONTACT', 'LOCATION', 'POLICY']),
          title: z.string().trim().min(2).max(120),
          content: z.string().trim().min(2).max(600),
          ...sourced,
        }),
      )
      .max(20),
  }),
  async handler(input, runCtx) {
    const pageText = new Map(runCtx.state.pages.map((p) => [p.url, normalise(`${p.title}\n${p.text}\n${p.sections.map((s) => `${s.heading}\n${s.text}`).join('\n')}`)]));
    const problems = [];
    const check = (kind, item, i) => {
      const text = pageText.get(item.source_url);
      if (!text) return problems.push({ item: `${kind}[${i}]`, problem: 'source_url is not one of the crawled pages' });
      if (!text.includes(normalise(item.evidence))) problems.push({ item: `${kind}[${i}]`, problem: 'evidence is not a word-for-word quote from the page' });
      if (item.price_text && !text.includes(normalise(item.price_text))) problems.push({ item: `${kind}[${i}]`, problem: 'price_text does not appear on the page; use null if no price is stated' });
    };
    input.services.forEach((s, i) => check('services', s, i));
    input.faqs.forEach((f, i) => check('faqs', f, i));
    input.business_info.forEach((b, i) => check('business_info', b, i));
    if (problems.length) {
      throw new ToolPolicyError('UNVERIFIED_CONTENT', 'Some items could not be verified against the website. Fix or drop them and call again.', problems.slice(0, 20));
    }
    runCtx.state.extracted = input;
    return { saved: true, services: input.services.length, faqs: input.faqs.length, info: input.business_info.length };
  },
});

export const searchBusinessKnowledge = defineTool({
  name: 'search_business_knowledge',
  description:
    "Search the business's owner-approved knowledge base (FAQs, policies, service area, hours, service descriptions). " +
    'Use it to answer customer questions. Prices here are for reference only: quote prices solely from get_business_pricing.',
  access: 'read',
  scope: 'business',
  input: z.strictObject({ query: z.string().trim().min(2).max(200) }),
  async handler({ query }, runCtx) {
    const items = await prisma.knowledgeItem.findMany({
      where: { businessId: runCtx.businessId, status: 'APPROVED' },
      select: { type: true, title: true, content: true, priceText: true, source: true },
    });
    const terms = normalise(query).split(' ').filter((t) => t.length > 2);
    const ranked = items
      .map((item) => {
        const hay = normalise(`${item.title} ${item.content}`);
        return { item, score: terms.filter((t) => hay.includes(t)).length };
      })
      .filter((r) => r.score > 0 || terms.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ item }) => ({ type: item.type, title: item.title, content: item.content, source: item.source === 'OWNER' ? 'owner' : 'website (owner-approved)' }));
    return { results: ranked, note: ranked.length ? 'Only owner-approved knowledge is returned.' : 'Nothing approved matches; do not guess, offer to check with the owner.' };
  },
});
