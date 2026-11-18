import { leadIntelligenceAgent } from './leadIntelligence.js';
import { conversationAgent } from './conversation.js';
import { orchestratorAgent } from './orchestrator.js';
import { salesInsightsAgent } from './salesInsights.js';

export const AGENTS = Object.freeze({
  orchestrator: orchestratorAgent,
  lead_intelligence: leadIntelligenceAgent,
  conversation: conversationAgent,
});

/** Business-level agents (not tied to a single lead). */
export const BUSINESS_AGENTS = Object.freeze({ sales_insights: salesInsightsAgent });
