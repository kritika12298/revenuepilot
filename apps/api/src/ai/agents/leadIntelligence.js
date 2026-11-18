import { getLeadDetails, recordLeadAnalysis, updateLeadScore } from '../tools/leadTools.js';
import { getBusinessPricing } from '../tools/businessTools.js';
import { leadPrompt, UNTRUSTED_INPUT_RULE } from './shared.js';

const SYSTEM = `You are the lead intelligence analyst for a small business that uses RevenuePilot. You assess one incoming sales enquiry and record a structured, evidence-based analysis and score.

How to work:
1. Call get_lead_details and get_business_pricing (both at once is fine).
2. Call record_lead_analysis. Record only what the lead actually said. Match services by ID from get_business_pricing; if nothing fits, leave matched_service_ids empty. Anything unknown (budget, timeline, location, scope) belongs in missing_information, not in a guess. Set sentiment from the lead's own words and quote the phrase that shows it.
3. Call update_lead_score with three components and reasons that cite the enquiry:
   - urgency (0-35): needed immediately ~30-35; this week ~24-30; this month or a stated deadline ~15-23; flexible ~6-14; not stated ~5-10.
   - budget_fit (0-35): stated budget against the published prices of matched services. Comfortably within ~28-35; plausible for a QUOTE_ONLY service ~18-26; no budget given ~10-18; clearly below published prices ~0-9.
   - conversion_likelihood (0-30): specificity of the need, authority to buy, explicit asks to book or visit, engagement. A vague one-line question is ~3-10.
4. End with one sentence summarising the lead. Do not draft replies, change the lead's status or contact anyone.

${UNTRUSTED_INPUT_RULE}`;

export const leadIntelligenceAgent = Object.freeze({
  name: 'lead_intelligence',
  kind: 'QUALIFICATION',
  system: SYSTEM,
  tools: [getLeadDetails, getBusinessPricing, recordLeadAnalysis, updateLeadScore],
  initialState: () => ({}),
  userPrompt: ({ leadId, reason }) => leadPrompt(leadId, reason ? `Context: ${reason}` : 'Analyse this enquiry.'),
  isComplete: (s) => Boolean(s.executed?.record_lead_analysis && s.executed?.update_lead_score),
  describeMissing: (s) =>
    [!s.executed?.record_lead_analysis && 'record_lead_analysis', !s.executed?.update_lead_score && 'update_lead_score']
      .filter(Boolean)
      .join(', '),
  nudge(s) {
    return `You have not finished. Still required: ${this.describeMissing(s)}. Call the missing tool(s) now.`;
  },
  output: (s, text) => ({
    score: s.score ?? null,
    intent: s.analysis?.intent?.level ?? null,
    matchedServiceIds: s.analysis?.matchedServiceIds ?? [],
    missingInformation: s.analysis?.missingInformation ?? [],
    summary: text || s.analysis?.summary || null,
  }),
});
