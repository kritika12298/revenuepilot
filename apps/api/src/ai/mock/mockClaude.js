import { analyse, composeReply, leadText } from './heuristics.js';

/**
 * Offline stand-in for the Claude Messages API, used when AI_MODE=mock (and
 * in tests). It returns real `tool_use` / `text` content blocks, so the agent
 * loop, server-side validation, permission checks and audit trail run exactly
 * as they do against Claude. Decisions come from simple heuristics.
 */

let seq = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_mock_${(seq += 1)}`, name, input });
const text = (t) => ({ type: 'text', text: t });

/** Reconstructs which tools were called so far and what they returned. */
function history(messages) {
  const calls = [];
  const byId = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        const call = { name: block.name, input: block.input, result: undefined, isError: false };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block.type === 'tool_result' && byId.has(block.tool_use_id)) {
        const call = byId.get(block.tool_use_id);
        call.result = JSON.parse(block.content);
        call.isError = Boolean(block.is_error);
      }
    }
  }
  const last = (name) => [...calls].reverse().find((c) => c.name === name);
  const ok = (name) => calls.find((c) => c.name === name && !c.isError);
  return { calls, last, ok };
}

function leadIdFrom(messages) {
  const first = typeof messages[0].content === 'string' ? messages[0].content : '';
  return first.match(/Lead ID: ([0-9a-f-]{36})/)?.[1];
}

const respond = (content) => ({
  id: `msg_mock_${(seq += 1)}`,
  type: 'message',
  role: 'assistant',
  model: 'mock',
  content,
  stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
  usage: { input_tokens: 0, output_tokens: 0 },
});

const behaviours = {
  lead_intelligence(messages) {
    const leadId = leadIdFrom(messages);
    const h = history(messages);
    const details = h.ok('get_lead_details')?.result;
    const pricing = h.ok('get_business_pricing')?.result;
    if (!details || !pricing) {
      return [toolUse('get_lead_details', { lead_id: leadId }), toolUse('get_business_pricing', {})];
    }
    if (!h.ok('record_lead_analysis') || !h.ok('update_lead_score')) {
      if (h.last('record_lead_analysis')?.isError || h.last('update_lead_score')?.isError) {
        return [text('I could not save the analysis.')];
      }
      const { analysis, score } = analyse(details, pricing);
      return [
        toolUse('record_lead_analysis', { lead_id: leadId, ...analysis }),
        toolUse('update_lead_score', { lead_id: leadId, ...score }),
      ];
    }
    const s = h.ok('update_lead_score').result;
    return [text(`Lead analysed and scored ${s.score}/100.`)];
  },

  conversation(messages) {
    const leadId = leadIdFrom(messages);
    const goal = messages[0].content.match(/Goal: (\w+)/)?.[1] ?? 'FIRST_RESPONSE';
    const h = history(messages);
    const details = h.ok('get_lead_details')?.result;
    const pricing = h.ok('get_business_pricing')?.result;
    if (!details || !pricing) {
      return [toolUse('get_lead_details', { lead_id: leadId }), toolUse('get_business_pricing', {})];
    }
    const sent = h.ok('send_customer_email');
    if (sent) return [text(sent.result.status === 'QUEUED_FOR_SENDING' ? 'Email queued for sending.' : 'Email held for owner approval.')];

    const attempts = h.calls.filter((c) => c.name === 'send_customer_email').length;
    const lastAttempt = h.last('send_customer_email');
    if (lastAttempt?.isError && lastAttempt.result.error === 'NOT_PERMITTED') return [text('This lead cannot be emailed.')];
    if (attempts >= 2) return [text('I could not produce a compliant draft.')];
    const guidance = messages[0].content.match(/Guidance: (.*)/)?.[1] ?? '';
    const reply = composeReply(details, pricing, goal, guidance);
    if (attempts === 1) {
      // Rejected once: retry without any prices.
      reply.body = reply.body
        .split('\n')
        .filter((l) => !/\d/.test(l) || l.startsWith('-'))
        .join('\n');
      reply.referenced_service_ids = [];
    }
    return [toolUse('send_customer_email', { lead_id: leadId, ...reply })];
  },

  orchestrator(messages) {
    const leadId = leadIdFrom(messages);
    const h = history(messages);
    const details = h.ok('get_lead_details')?.result;
    if (!details) return [toolUse('get_lead_details', { lead_id: leadId })];

    const intel = h.last('run_lead_intelligence');
    if (!details.lead.analysis && !intel) {
      return [toolUse('run_lead_intelligence', { lead_id: leadId, reason: 'New enquiry without analysis.' })];
    }
    const score = intel && !intel.isError ? intel.result.score : details.lead.score;
    const analysed = Boolean(details.lead.analysis) || (intel && !intel.isError);

    if (
      analysed &&
      ['NEW', 'QUALIFYING'].includes(details.lead.status) &&
      (score ?? 0) >= 50 &&
      !h.last('update_lead_status')
    ) {
      return [toolUse('update_lead_status', { lead_id: leadId, status: 'QUALIFIED', reason: `Score ${score} with a matching service.` })];
    }
    const alreadyAlerted = details.recent_owner_notifications.some((n) => n.reason === 'HOT_LEAD');
    if ((score ?? 0) >= 75 && !alreadyAlerted && !h.last('notify_business_owner')) {
      return [
        toolUse('notify_business_owner', {
          lead_id: leadId,
          reason: 'HOT_LEAD',
          priority: 'URGENT',
          message: `${details.lead.name} scored ${score}/100. Respond quickly to win this one.`,
        }),
      ];
    }
    const said = leadText(details).toLowerCase();
    if (analysed && /(discount|% off|cheaper|better price|multi-property pricing)/.test(said) && !details.pending_approvals.some((a) => a.type === 'DISCOUNT') && !h.last('request_owner_approval')) {
      return [
        toolUse('request_owner_approval', {
          lead_id: leadId,
          type: 'DISCOUNT',
          summary: `${details.lead.name} asked about a discount or better pricing.`,
          reason: 'The lead asked for a discount or better pricing in their message.',
        }),
      ];
    }
    if (
      analysed &&
      /(book|schedule|appointment|consultation|site visit|come out|come by|take a look)/.test(said) &&
      !details.appointments.length &&
      !h.last('run_meeting_agent')
    ) {
      return [toolUse('run_meeting_agent', { lead_id: leadId, reason: 'The lead asked for a visit or consultation.' })];
    }
    const waitingOnUs = details.last_message_from === 'LEAD';
    const draftPending = details.pending_approvals.some((a) => a.type === 'OUTBOUND_MESSAGE');
    if (analysed && waitingOnUs && !draftPending && !h.last('run_conversation_agent')) {
      const missing = intel?.result?.missingInformation ?? details.lead.analysis?.missingInformation ?? [];
      return [
        toolUse('run_conversation_agent', {
          lead_id: leadId,
          goal: missing.length ? 'ASK_MISSING_INFORMATION' : 'FIRST_RESPONSE',
        }),
      ];
    }
    if (!h.last('record_next_action')) {
      const convo = h.last('run_conversation_agent');
      const drafted = convo && !convo.isError ? convo.result.draftMessageId : null;
      const autoSent = convo && !convo.isError && convo.result.sent;
      const blocked = convo?.isError && convo.result.error === 'AUTO_RESPONSES_OFF';
      const [nextAction, rationale] = blocked
        ? ['OWNER_ACTION_REQUIRED', 'Automatic responses are turned off; please reply to this lead yourself.']
        : autoSent
          ? ['AWAIT_LEAD_REPLY', 'A reply was sent automatically under your autonomy settings; waiting for the lead.']
          : drafted
        ? ['AWAIT_OWNER_APPROVAL', 'A reply draft is waiting for your approval.']
        : draftPending
          ? ['AWAIT_OWNER_APPROVAL', 'An earlier reply draft is still waiting for your approval.']
          : waitingOnUs
            ? ['OWNER_ACTION_REQUIRED', 'The lead is waiting for a reply but no draft could be prepared.']
            : ['AWAIT_LEAD_REPLY', 'We replied last; waiting for the lead.'];
      return [toolUse('record_next_action', { lead_id: leadId, next_action: nextAction, rationale })];
    }
    return [text('Done.')];
  },
};

/** Fact id -> how the mock turns it into a recommendation. */
const INSIGHT_RULES = [
  ['waiting_for_reply', 'HIGH', 'RESPONSE_TIME', (f) => `Reply to ${f.value} waiting lead${f.value > 1 ? 's' : ''}`, 'Answer the leads who wrote last today; open Conversations and filter by "Awaiting reply".'],
  ['hot_leads_not_contacted', 'HIGH', 'PIPELINE', (f) => `Contact ${f.value} high-scoring lead${f.value > 1 ? 's' : ''}`, 'Run the AI on these leads or reply yourself; they are the most likely to buy.'],
  ['pending_approvals', 'HIGH', 'APPROVALS', (f) => `Clear ${f.value} pending approval${f.value > 1 ? 's' : ''}`, 'Review and approve or reject the waiting drafts and requests so messages are not held up.'],
  ['first_response_time', 'MEDIUM', 'RESPONSE_TIME', () => 'Speed up first replies', 'Approve AI first replies as soon as they arrive, or turn on notifications, to reply within the hour.', (f) => f.value > 60],
  ['funnel_dropoff', 'MEDIUM', 'PIPELINE', () => 'Fix the biggest funnel drop-off', 'Look at the leads stuck at this stage and follow up with a specific next step, such as offering a site visit.'],
  ['lost_reasons', 'MEDIUM', 'PRICING', () => 'Address why leads are lost', 'Review the lost leads for the most common reason and adjust how pricing and value are explained.'],
  ['unanalysed_leads', 'MEDIUM', 'LEAD_QUALITY', (f) => `Analyse ${f.value} unscored lead${f.value > 1 ? 's' : ''}`, 'Run the AI on these leads so they get a score and a draft reply.'],
  ['missing_information', 'LOW', 'LEAD_QUALITY', () => 'Ask for key details up front', 'Add the most commonly missing details as fields on your website enquiry form.'],
  ['unmatched_requests', 'LOW', 'SERVICES', () => 'Review requests outside your services', 'Check whether these requests point to a service worth adding to your price list.'],
  ['out_of_hours_enquiries', 'LOW', 'RESPONSE_TIME', () => 'Plan for out-of-hours enquiries', 'Check overnight enquiries first thing each morning so they get the first reply of the day.', (f) => f.value >= 30],
  ['follow_up_response', 'LOW', 'FOLLOW_UP', () => 'Tune your follow-up timing', 'Compare follow-up delays in Settings with when leads actually reply.'],
];

behaviours.sales_insights = (messages) => {
  const h = history(messages);
  const facts = h.ok('get_sales_facts')?.result;
  if (!facts) return [toolUse('get_sales_facts', {})];
  if (h.last('record_insights')) return [text(`Reviewed ${facts.leads_in_range} leads in range.`)];
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const insights = [];
  for (const [id, priority, category, title, recommendation, applies = () => true] of INSIGHT_RULES) {
    const fact = byId.get(id);
    if (!fact || !applies(fact) || insights.length >= 5) continue;
    insights.push({ title: title(fact), recommendation, reason: fact.detail, evidence: [id], priority, category });
  }
  return [toolUse('record_insights', { insights })];
};

const PRICE_SENTENCE = /[^.]*\$\s?\d[^.]*\./;
const firstSentence = (t) => (t.match(/^[^.!?]+[.!?]/)?.[0] ?? t).trim();

behaviours.website_intelligence = (messages) => {
  const h = history(messages);
  const site = h.ok('get_website_pages')?.result;
  if (!site) return [toolUse('get_website_pages', {})];
  const lastSave = h.last('record_business_knowledge');
  if (lastSave && !lastSave.isError) return [text('Website knowledge recorded.')];
  if (lastSave?.isError) return [text('Could not verify the extracted content.')];

  const services = [];
  const faqs = [];
  const info = [];
  for (const page of site.pages) {
    const isServices = /servic|pric/i.test(page.url) || /servic|pric/i.test(page.title);
    for (const sec of page.sections) {
      if (!sec.text) continue;
      if (sec.heading.endsWith('?')) {
        faqs.push({ question: sec.heading, answer: sec.text, source_url: page.url, evidence: firstSentence(sec.text) });
      } else if (isServices && !/^services/i.test(sec.heading)) {
        const price = sec.text.match(PRICE_SENTENCE)?.[0]?.trim() ?? null;
        services.push({ name: sec.heading, description: firstSentence(sec.text), price_text: price, source_url: page.url, evidence: firstSentence(sec.text) });
      } else if (/hour/i.test(sec.heading)) {
        info.push({ type: 'BUSINESS_INFO', title: 'Opening hours', content: sec.text, source_url: page.url, evidence: firstSentence(sec.text) });
      } else if (/phone|email|contact/i.test(sec.heading)) {
        info.push({ type: 'CONTACT', title: sec.heading, content: sec.text, source_url: page.url, evidence: sec.text.slice(0, 120) });
      } else if (/area|location/i.test(sec.heading)) {
        info.push({ type: 'LOCATION', title: 'Service area', content: sec.text, source_url: page.url, evidence: firstSentence(sec.text) });
      }
    }
  }
  const home = site.pages[0];
  return [
    toolUse('record_business_knowledge', {
      business_summary: (home?.description ?? firstSentence(home?.text ?? 'Small business website.')).slice(0, 600),
      services: services.slice(0, 25),
      faqs: faqs.slice(0, 30),
      business_info: info.slice(0, 20),
    }),
  ];
};

behaviours.meeting = (messages) => {
  const leadId = leadIdFrom(messages);
  const h = history(messages);
  const details = h.ok('get_lead_details')?.result;
  const pricing = h.ok('get_business_pricing')?.result;
  if (!details || !pricing) return [toolUse('get_lead_details', { lead_id: leadId }), toolUse('get_business_pricing', {})];
  const service = pricing.services.find((s) => (details.lead.analysis?.matchedServiceIds ?? []).includes(s.id) && s.duration_minutes) ?? null;
  const duration = Math.min(Math.max(service?.duration_minutes ?? 60, 30), 240);
  const availability = h.last('check_calendar_availability');
  if (!availability) return [toolUse('check_calendar_availability', { lead_id: leadId, duration_minutes: duration, days_ahead: 10 })];
  if (availability.isError || !availability.result.slots?.length) return [text('No suitable slot was available.')];
  const booking = h.last('book_appointment');
  if (!booking) {
    const slot = availability.result.slots[0];
    return [
      toolUse('book_appointment', {
        lead_id: leadId,
        start: slot.start,
        duration_minutes: duration,
        title: service ? service.name : 'Site visit',
        service_id: service?.id ?? null,
        reason: 'Earliest available slot; the lead did not state a preference.',
      }),
    ];
  }
  return [text(booking.isError ? `Booking failed: ${booking.result.message}` : `Appointment ${booking.result.status === 'CONFIRMED' ? 'booked' : 'proposed to the owner'}.`)];
};

behaviours.follow_up_planner = (messages) => {
  const leadId = leadIdFrom(messages);
  const h = history(messages);
  const policy = h.ok('get_follow_up_policy')?.result;
  if (!h.ok('get_lead_details') || !policy) return [toolUse('get_lead_details', { lead_id: leadId }), toolUse('get_follow_up_policy', { lead_id: leadId })];
  if (h.last('record_follow_up_decision')) return [text('Follow-up decision recorded.')];
  if (!policy.can_schedule) return [toolUse('record_follow_up_decision', { lead_id: leadId, decision: 'NONE', reason: `No follow-up: ${policy.blocked_reason}.` })];
  const scheduled = h.last('schedule_followup');
  if (!scheduled) {
    return [toolUse('schedule_followup', { lead_id: leadId, delay_hours: policy.suggested_delay_hours, reason: `No reply yet; following the ${policy.suggested_delay_hours}h cadence.` })];
  }
  return [
    toolUse('record_follow_up_decision', {
      lead_id: leadId,
      decision: scheduled.isError ? 'NONE' : 'SCHEDULE',
      reason: scheduled.isError ? scheduled.result.message : `Follow-up ${scheduled.result.step} in ${policy.suggested_delay_hours} hours, within working hours.`,
    }),
  ];
};

export function createMockClaude() {
  return {
    mode: 'mock',
    model: 'mock',
    async createMessage({ agent, messages }) {
      const behaviour = behaviours[agent];
      if (!behaviour) throw new Error(`Mock has no behaviour for agent "${agent}"`);
      return respond(behaviour(messages));
    },
  };
}
