import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { computeFacts } from '../insights/facts.js';
import { defineTool, ToolPolicyError } from './define.js';

export const INSIGHT_CATEGORIES = ['RESPONSE_TIME', 'PIPELINE', 'FOLLOW_UP', 'PRICING', 'SERVICES', 'APPROVALS', 'LEAD_QUALITY'];

export const getSalesFacts = defineTool({
  name: 'get_sales_facts',
  description:
    "Compute facts about this business's leads, conversations, scores and follow-ups for the analysis window. " +
    'Each fact has an id you must cite as evidence. These facts are the only data you may base insights on.',
  access: 'read',
  scope: 'business',
  input: z.strictObject({}),
  async handler(_input, runCtx) {
    const result = await computeFacts(runCtx.businessId, runCtx.state.range);
    runCtx.state.facts = result.facts;
    runCtx.state.cohortSize = result.cohortSize;
    return {
      range: result.range,
      leads_in_range: result.cohortSize,
      facts: result.facts.map(({ id, title, value, unit, detail }) => ({ id, title, value, unit: unit ?? 'count', detail })),
    };
  },
});

const insight = z.strictObject({
  title: z.string().trim().min(5).max(80).describe('Short headline, e.g. "Reply to 3 waiting leads".'),
  recommendation: z.string().trim().min(10).max(300).describe('The concrete action the owner should take.'),
  reason: z.string().trim().min(10).max(400).describe('Why: the numbers from the cited facts that support it.'),
  evidence: z.array(z.string().min(2).max(60)).min(1).max(4).describe('Fact ids from get_sales_facts.'),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  category: z.enum(INSIGHT_CATEGORIES),
  lead_ids: z.array(z.uuid()).max(10).optional().describe('Leads this applies to, if specific.'),
});

export const recordInsights = defineTool({
  name: 'record_insights',
  description:
    'Save up to 5 prioritised, actionable insights. Every insight must cite fact ids from get_sales_facts as evidence ' +
    'and only use numbers that appear in those facts. Save an empty list if the facts do not support any recommendation.',
  access: 'write',
  scope: 'business',
  input: z.strictObject({ insights: z.array(insight).max(5) }),
  async handler({ insights }, runCtx) {
    if (!runCtx.state.facts) throw new ToolPolicyError('FACTS_REQUIRED', 'Call get_sales_facts first.');
    const known = new Map(runCtx.state.facts.map((f) => [f.id, f]));
    const unknown = insights.flatMap((i) => i.evidence.filter((id) => !known.has(id)));
    if (unknown.length) {
      throw new ToolPolicyError('UNKNOWN_EVIDENCE', 'Insights may only cite fact ids returned by get_sales_facts.', { unknown: [...new Set(unknown)] });
    }
    // Every number written in an insight must appear in the facts it cites (no invented figures).
    const numbersIn = (text) => (String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
    const ungrounded = [];
    for (const i of insights) {
      const cited = i.evidence.map((id) => known.get(id));
      const allowed = new Set(cited.flatMap((f) => [f.value, ...numbersIn(`${f.title} ${f.detail}`)]).filter((n) => typeof n === 'number'));
      for (const n of numbersIn(`${i.title} ${i.recommendation} ${i.reason}`)) if (n > 1 && !allowed.has(n)) ungrounded.push({ insight: i.title, number: n });
    }
    if (ungrounded.length) {
      throw new ToolPolicyError('UNGROUNDED_NUMBER', 'Use only numbers that appear in the facts each insight cites.', { ungrounded });
    }
    const leadIds = [...new Set(insights.flatMap((i) => i.lead_ids ?? []))];
    if (leadIds.length) {
      const found = await prisma.lead.count({ where: { id: { in: leadIds }, businessId: runCtx.businessId } });
      if (found !== leadIds.length) throw new ToolPolicyError('UNKNOWN_LEAD', 'lead_ids must be leads of this business.');
    }
    runCtx.state.insights = insights.map((i) => ({
      title: i.title,
      recommendation: i.recommendation,
      reason: i.reason,
      priority: i.priority,
      category: i.category,
      leadIds: i.lead_ids ?? [],
      // Store the cited facts with the insight so the UI can show the evidence verbatim.
      evidence: i.evidence.map((id) => ({ id, title: known.get(id).title, detail: known.get(id).detail })),
    }));
    return { saved: runCtx.state.insights.length };
  },
});
