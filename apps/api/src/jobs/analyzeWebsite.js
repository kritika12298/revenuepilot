import { UnrecoverableError } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { crawlSite } from '../website/crawler.js';
import { runAgent } from '../ai/runAgent.js';
import { websiteIntelligenceAgent } from '../ai/agents/websiteIntelligence.js';
import { AIError } from '../ai/errors.js';
import * as notifications from '../modules/notifications/notification.repository.js';
import { isFinalAttempt } from './failures.js';

/** Checklist of what a lead-handling knowledge base should contain. */
function missingInfo(extracted) {
  const missing = [];
  if (!extracted.services.length) missing.push('Services you offer');
  if (!extracted.services.some((s) => s.price_text)) missing.push('Published prices for any service');
  if (!extracted.business_info.some((b) => /hour/i.test(b.title + b.content))) missing.push('Opening hours');
  if (!extracted.business_info.some((b) => b.type === 'CONTACT')) missing.push('Phone number or email address');
  if (!extracted.business_info.some((b) => b.type === 'LOCATION') && !extracted.faqs.some((f) => /area|serve/i.test(f.question))) missing.push('Service area');
  if (!extracted.faqs.length) missing.push('Frequently asked questions');
  return missing;
}

/**
 * Crawl the business website (SSRF-guarded) and extract a knowledge base with
 * the Website Intelligence Agent. Extracted items are stored as PENDING_REVIEW
 * (inferred) and replace earlier unreviewed items; owner-approved or rejected
 * items are kept as they are.
 */
export async function processAnalyzeWebsite(job, { fetcher } = {}) {
  const { businessId, requestedBy } = job.data;
  const website = await prisma.businessWebsite.findUnique({ where: { businessId } });
  if (!website) return { outcome: 'SKIPPED', reason: 'No website connected' };

  await prisma.businessWebsite.update({ where: { businessId }, data: { status: 'FETCHING', lastError: null } });
  const crawl = await crawlSite(website.url, { fetcher });
  if (!crawl.pages.length) {
    const reason = crawl.errors[0]?.error ?? 'No pages could be fetched';
    await prisma.businessWebsite.update({ where: { businessId }, data: { status: 'FAILED', lastError: reason, pages: crawl.errors } });
    return { outcome: 'FAILED', reason };
  }
  await prisma.businessWebsite.update({
    where: { businessId },
    data: { status: 'ANALYZING', pagesFetched: crawl.pages.length, pages: crawl.pages.map((p) => ({ url: p.url, title: p.title })).concat(crawl.errors.map((e) => ({ url: e.url, error: e.error }))) },
  });

  let run;
  let state;
  try {
    const result = await runAgent(websiteIntelligenceAgent, {
      businessId,
      leadId: null,
      triggeredById: requestedBy,
      trigger: requestedBy ? 'USER' : 'SYSTEM',
      triggerDetail: `Website analysis of ${website.url}${crawl.demo ? ' (bundled demo site)' : ''}`,
      jobAttempt: job.attemptsMade + 1,
      input: { url: website.url, pages: crawl.pages.length },
      state: { pages: crawl.pages, url: website.url },
    });
    run = result.run;
    state = await prisma.agentRun.findUnique({ where: { id: run.id }, select: { output: true } });
  } catch (err) {
    if (err instanceof AIError && err.retryable && !isFinalAttempt(job)) throw err;
    await prisma.businessWebsite.update({ where: { businessId }, data: { status: 'FAILED', lastError: err.message } });
    throw new UnrecoverableError(`Website analysis failed: ${err.message}`);
  }

  // The agent's validated extraction lives on the run's tool call; re-read it from there.
  const call = await prisma.agentToolCall.findFirst({
    where: { agentRunId: run.id, toolName: 'record_business_knowledge', outcome: 'EXECUTED' },
    orderBy: { createdAt: 'desc' },
  });
  const extracted = call.input;
  const missing = missingInfo(extracted);

  const items = [
    ...extracted.services.map((s) => ({ type: 'SERVICE', title: s.name, content: s.description, priceText: s.price_text, sourceUrl: s.source_url, evidence: s.evidence })),
    ...extracted.faqs.map((f) => ({ type: 'FAQ', title: f.question, content: f.answer, sourceUrl: f.source_url, evidence: f.evidence })),
    ...extracted.business_info.map((b) => ({ type: b.type, title: b.title, content: b.content, sourceUrl: b.source_url, evidence: b.evidence })),
  ];

  const created = await prisma.$transaction(async (tx) => {
    const reviewed = await tx.knowledgeItem.findMany({ where: { businessId, status: { in: ['APPROVED', 'REJECTED'] } }, select: { type: true, title: true } });
    const decided = new Set(reviewed.map((r) => `${r.type}:${r.title.toLowerCase()}`));
    await tx.knowledgeItem.deleteMany({ where: { businessId, source: 'WEBSITE', status: 'PENDING_REVIEW' } });
    const fresh = items.filter((i) => !decided.has(`${i.type}:${i.title.toLowerCase()}`));
    if (fresh.length) {
      await tx.knowledgeItem.createMany({ data: fresh.map((i) => ({ ...i, businessId, websiteId: website.id, source: 'WEBSITE', status: 'PENDING_REVIEW' })) });
    }
    await tx.businessWebsite.update({
      where: { businessId },
      data: { status: 'COMPLETED', summary: extracted.business_summary, missingInfo: missing, lastSyncAt: new Date(), agentRunId: run.id },
    });
    await notifications.create(
      {
        businessId,
        reason: 'WEBSITE_ANALYSIS',
        priority: 'NORMAL',
        agentRunId: run.id,
        message: `Website analysed: ${fresh.length} item${fresh.length === 1 ? '' : 's'} to review${missing.length ? `; missing: ${missing.join(', ')}` : ''}.`,
      },
      tx,
    );
    return fresh.length;
  });
  return { outcome: 'COMPLETED', itemsForReview: created, missing, output: state.output };
}
