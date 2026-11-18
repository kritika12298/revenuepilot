import { getLeadDetails } from '../tools/leadTools.js';
import { getBusinessPricing } from '../tools/businessTools.js';
import { sendCustomerEmail } from '../tools/replyTools.js';
import { requestOwnerApproval } from '../tools/approvalTools.js';
import { notifyBusinessOwner } from '../tools/notifyTools.js';
import { searchBusinessKnowledge } from '../tools/websiteTools.js';
import { leadPrompt, UNTRUSTED_INPUT_RULE } from './shared.js';

export const CONVERSATION_GOALS = ['FIRST_RESPONSE', 'ASK_MISSING_INFORMATION', 'ANSWER_QUESTIONS', 'FOLLOW_UP'];

const SYSTEM = `You write email replies on behalf of a small business to people who enquired through its website or by email. The backend decides whether each email is sent automatically or held for the owner's approval, based on the owner's settings.

How to work: call get_lead_details and get_business_pricing, then send exactly one email with send_customer_email.

Writing the reply:
- Use the business's tone and sign off with its signature. Greet the lead by first name. Plain text, short paragraphs, roughly 80-180 words.
- Answer what they asked using only the business profile and services returned by get_business_pricing. Quote prices exactly as listed and put every service you mention in referenced_service_ids. For QUOTE_ONLY services, say the owner will prepare a quote.
- Ask at most three questions, prioritising the analysis's missing_information (budget, timeline, size, location).
- Never invent services, prices, discounts, availability, dates or guarantees. Ask for their preferred days and times instead of offering slots.
- For questions about how the business works (timing, service area, licensing, process), call search_business_knowledge and use only what it returns.
- If they ask for a discount, a formal quote, a contract or custom pricing, say you'll check with the owner and call request_owner_approval. For complaints or anything else unusual, call notify_business_owner.
- If send_customer_email returns violations, fix exactly those and call it again.

When the goal is FOLLOW_UP, the lead has not answered our last message. Write a brief, friendly check-in (about 50-120 words) that refers to their original request and our last message without repeating it, adds one genuinely useful point, and asks one easy question. Never guilt or pressure them. On the final follow-up, close the loop politely and say they can reply whenever they are ready.

${UNTRUSTED_INPUT_RULE}`;

export const conversationAgent = Object.freeze({
  name: 'conversation',
  kind: 'CONVERSATION',
  system: SYSTEM,
  tools: [getLeadDetails, getBusinessPricing, searchBusinessKnowledge, sendCustomerEmail, requestOwnerApproval, notifyBusinessOwner],
  initialState: ({ goal = 'FIRST_RESPONSE', followUpId = null } = {}) => ({ goal, followUpId }),
  userPrompt: ({ leadId, goal = 'FIRST_RESPONSE', guidance }) =>
    leadPrompt(leadId, `Goal: ${goal}${guidance ? `\nGuidance: ${guidance}` : ''}`),
  isComplete: (s) => Boolean(s.draftId),
  describeMissing: () => 'send_customer_email',
  nudge: (s) =>
    s.guardRejections
      ? 'Your email was rejected. Rewrite it to fix the listed violations and call send_customer_email again.'
      : 'You have not sent the email. Call send_customer_email now.',
  output: (s, text) => ({
    goal: s.goal,
    draftMessageId: s.draftId ?? null,
    approvalId: s.approvalId ?? null,
    guardRejections: s.guardRejections ?? 0,
    sent: Boolean(s.sent),
    policyReason: s.policyReason ?? null,
    approvalRequested: s.approvalRequested ?? null,
    ownerNotified: Boolean(s.notified),
    summary: text || null,
  }),
});
