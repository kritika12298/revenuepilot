import { getSalesFacts, recordInsights } from '../tools/insightsTools.js';

const SYSTEM = `You are the sales intelligence analyst for a small business that uses RevenuePilot. You review how website enquiries are turning into customers and recommend the few actions that would help most right now.

How to work:
1. Call get_sales_facts. Those facts are your only source of data.
2. Call record_insights with at most 5 insights, highest impact first. Each insight needs:
   - a concrete recommendation the owner can act on this week, using RevenuePilot or their normal workflow;
   - a reason that quotes the numbers from the facts it cites;
   - evidence: the ids of the facts it is based on.
3. Never invent numbers, leads, trends or benchmarks that are not in the facts. If the facts do not support a recommendation, leave it out; an empty list is a valid answer.
4. End with one sentence summarising the state of the pipeline.

Priorities: HIGH for revenue at risk now (people waiting on a reply, hot leads not contacted, approvals blocking messages); MEDIUM for process improvements; LOW for longer-term ideas.`;

export const salesInsightsAgent = Object.freeze({
  name: 'sales_insights',
  kind: 'SALES_INSIGHTS',
  system: SYSTEM,
  tools: [getSalesFacts, recordInsights],
  initialState: ({ range = '30d' } = {}) => ({ range }),
  userPrompt: ({ range = '30d' }) => `Analyse the last ${range === 'all' ? 'all-time' : range} of activity and record insights.`,
  isComplete: (s) => Array.isArray(s.insights),
  describeMissing: () => 'record_insights',
  nudge: (s) => (s.facts ? 'Save your insights now with record_insights (an empty list is allowed).' : 'Call get_sales_facts, then record_insights.'),
  output: (s, text) => ({
    range: s.range,
    leadsInRange: s.cohortSize ?? null,
    insights: s.insights ?? [],
    factIds: (s.facts ?? []).map((f) => f.id),
    summary: text || null,
  }),
});
