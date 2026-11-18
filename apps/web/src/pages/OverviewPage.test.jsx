import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { OverviewPage } from './OverviewPage.jsx';

afterEach(() => vi.unstubAllGlobals());

const now = () => new Date().toISOString();

const summary = (range, leads = 12) => ({
  range,
  timezone: 'UTC',
  totals: { leads, qualified: 6, won: 3, lost: 2, previousLeads: 4 },
  conversionRate: 25,
  qualificationRate: 50,
  winRate: 60,
  averageScore: 71,
  medianFirstResponseMinutes: 95,
  pendingFollowUps: 3,
  followUps: { drafting: 1, needsApproval: 1, scheduled: 1 },
  pendingApprovals: 2,
  approvals: { replies: 1, followUps: 1, discounts: 0, quotes: 0, other: 0 },
  pipelineValue: { valueCents: 1250000, weightedCents: 310000, leadsWithValue: 4, leadsWithoutValue: 2 },
  funnel: [
    { stage: 'NEW', count: leads, percentOfTotal: 100, stepConversion: null },
    { stage: 'QUALIFYING', count: 8, percentOfTotal: 66.7, stepConversion: 66.7 },
    { stage: 'QUALIFIED', count: 6, percentOfTotal: 50, stepConversion: 75 },
    { stage: 'CONTACTED', count: 5, percentOfTotal: 41.7, stepConversion: 83.3 },
    { stage: 'ENGAGED', count: 4, percentOfTotal: 33.3, stepConversion: 80 },
    { stage: 'APPOINTMENT_BOOKED', count: 3, percentOfTotal: 25, stepConversion: 75 },
    { stage: 'WON', count: 3, percentOfTotal: 25, stepConversion: 100 },
  ],
  pipeline: [
    { status: 'NEW', count: 3 },
    { status: 'WON', count: 3 },
  ],
  leadsByDay: [
    { date: '2026-11-17', count: 2 },
    { date: '2026-11-18', count: 5 },
  ],
});

const agent = (key, name, status, extra = {}) => ({
  key,
  name,
  description: `${name} description`,
  status,
  currentTask: null,
  nextRunAt: null,
  lastRunAt: status === 'idle' ? null : now(),
  lastRun: null,
  stats: { runs: 0, succeeded: 0, failed: 0 },
  ...extra,
});

const agents = {
  data: [
    agent('lead_intelligence', 'Lead Intelligence Agent', 'running', { currentTask: 'Analysing Priya Shah', stats: { runs: 4, succeeded: 4, failed: 0 } }),
    agent('conversation', 'Conversation Agent', 'failed', {
      lastRun: { id: 'r2', status: 'FAILED', error: 'The AI provider is temporarily unavailable', lead: { id: 'l2', name: 'Sofia' } },
      stats: { runs: 2, succeeded: 1, failed: 1 },
    }),
    agent('follow_up', 'Follow-up Agent', 'scheduled', { currentTask: 'Send follow-up 1 to Hannah Becker', nextRunAt: now(), stats: { runs: 1, succeeded: 1, failed: 0, queued: 2 } }),
    agent('sales_intelligence', 'Sales Intelligence Agent', 'completed', {
      lastRun: { id: 'r4', status: 'SUCCEEDED', decision: 'Daniel Okafor: waiting for your approval', rationale: 'A reply draft is waiting.', lead: { id: 'l1', name: 'Daniel Okafor' } },
    }),
  ],
};

const insights = {
  data: {
    runId: 'run-1',
    generatedAt: now(),
    model: 'mock',
    trigger: 'USER',
    range: '30d',
    leadsInRange: 12,
    summary: 'Reviewed 12 leads.',
    newActivitySinceGenerated: 0,
    insights: [
      {
        title: 'Reply to 2 waiting leads',
        recommendation: 'Answer the leads who wrote last today.',
        reason: '2 open leads wrote last and are waiting for us (Sofia, Marcus).',
        priority: 'HIGH',
        category: 'RESPONSE_TIME',
        leadIds: [],
        evidence: [{ id: 'waiting_for_reply', title: 'Leads waiting for a reply', detail: '2 open leads wrote last and are waiting for us (Sofia, Marcus).' }],
      },
    ],
  },
};

const approvals = {
  data: [
    {
      id: 'a1',
      type: 'OUTBOUND_MESSAGE',
      createdAt: now(),
      aiRationale: 'First reply to a new enquiry; asks 2 qualifying questions.',
      lead: { id: 'l1', name: 'Daniel Okafor', status: 'QUALIFIED' },
      message: { id: 'm1', subject: 'Re: mowing', body: 'Hi Daniel, weekly lawn maintenance is $45–$85.', followUpJob: null },
      payload: {},
      agentRun: null,
    },
    {
      id: 'a2',
      type: 'DISCOUNT',
      createdAt: now(),
      aiRationale: 'Lead asked about multi-property pricing.',
      lead: { id: 'l1', name: 'Daniel Okafor', status: 'QUALIFIED' },
      message: null,
      payload: { kind: 'PERCENT', value: 10, appliesTo: 'Weekly lawn maintenance', condition: '3+ properties' },
      agentRun: null,
    },
  ],
  meta: { page: 1, pageSize: 4, total: 2, totalPages: 1 },
};

const activity = (category) => ({
  data:
    category === 'ai'
      ? [{ id: 'e2', type: 'AGENT_DECISION', actorType: 'AI', data: { nextAction: 'AWAIT_OWNER_APPROVAL', rationale: 'A reply draft is waiting for your approval.' }, createdAt: now(), lead: { id: 'l1', name: 'Daniel Okafor' } }]
      : [{ id: 'e1', type: 'SCORE_UPDATED', actorType: 'AI', data: { to: 82, method: 'AI' }, createdAt: now(), lead: { id: 'l1', name: 'Daniel Okafor' } }],
});

const routes = (overrides = {}) => ({
  'GET /api/dashboard/summary': ({ url }) => summary(url.searchParams.get('range'), url.searchParams.get('range') === '7d' ? 5 : 12),
  'GET /api/dashboard/agents': agents,
  'GET /api/dashboard/insights': insights,
  'GET /api/dashboard/activity': ({ url }) => activity(url.searchParams.get('category')),
  'GET /api/approvals': approvals,
  'GET /api/recommendations': {
    data: [
      {
        id: 'r1', type: 'HIGH_INTENT_NO_RESPONSE', priority: 'HIGH', title: 'Daniel Okafor is waiting for a reply',
        reason: 'High-intent lead (score 82) wrote 3 hours ago and has not had a reply.', suggestedAction: 'Approve the AI draft or reply now.',
        impact: { valueCents: 30000, basis: 'Budget stated by the lead ($300)' }, lead: { id: 'l1', name: 'Daniel Okafor' }, createdAt: now(),
      },
    ],
  },
  ...overrides,
});

const tile = (label) => screen.getByText(label, { selector: 'span[title]' }).closest('div.rounded-xl');
const tileValue = async (label, value) => {
  await screen.findByText(label, { selector: 'span[title]' });
  await waitFor(() => expect(within(tile(label)).getByText(value)).toBeInTheDocument());
};

describe('Overview KPIs', () => {
  it('shows metrics from the API with clear definitions', async () => {
    renderApp(<OverviewPage />, { routes: routes() });
    await tileValue('Total leads', '12');
    expect(within(tile('Total leads')).getByText('+8')).toBeInTheDocument();
    expect(within(tile('Qualified leads')).getByText('50% qualification rate')).toBeInTheDocument();
    expect(within(tile('Estimated pipeline')).getByText('$3,100')).toBeInTheDocument();
    expect(within(tile('Follow-ups to approve')).getByText('1')).toBeInTheDocument();
    expect(within(tile('Conversion rate')).getByText('3 won of 12')).toBeInTheDocument();
    expect(within(tile('Win rate')).getByText('3 won of 5 closed')).toBeInTheDocument();
    expect(screen.getByText('1h 35m')).toBeInTheDocument();

    // Follow-ups and approvals are separate, current-state counts with breakdowns.
    const followUps = tile('Pending follow-ups');
    expect(within(followUps).getByText('3')).toBeInTheDocument();
    expect(within(followUps).getByText('1 scheduled · 1 need approval · 1 drafting')).toBeInTheDocument();
    expect(within(followUps).getByText('Now')).toBeInTheDocument();
    expect(within(tile('Approvals waiting')).getByText('1 reply · 1 follow-up')).toBeInTheDocument();

    const info = screen.getByRole('button', { name: 'How win rate is calculated' });
    expect(info).toHaveAccessibleDescription(/Won leads divided by closed leads/);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument(); // hidden until hover/focus
    await userEvent.hover(info);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Won leads divided by closed leads/);
  });

  it('refetches range-scoped data (metrics and agent stats) when the date range changes', async () => {
    const { calls } = renderApp(<OverviewPage />, { routes: routes() });
    await tileValue('Total leads', '12');
    await userEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() => expect(within(tile('Total leads')).getByText('5')).toBeInTheDocument());
    const ranges = (path) => calls.filter((c) => c.path === path).map((c) => c.query.range);
    expect(ranges('/api/dashboard/summary')).toEqual(['30d', '7d']);
    expect(ranges('/api/dashboard/agents')).toEqual(['30d', '7d']);
  });

  it('shows an error state with retry', async () => {
    let fail = true;
    renderApp(<OverviewPage />, {
      routes: routes({
        'GET /api/dashboard/summary': () => (fail ? [500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId: 'req-9' } }] : summary('30d', 7)),
      }),
    });
    expect(await screen.findByText("Couldn't load your metrics")).toBeInTheDocument();
    expect(screen.getByText('Reference: req-9')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(within(tile('Total leads')).getByText('7')).toBeInTheDocument());
  });
});

describe('AI sales agents', () => {
  it('shows each agent state, task, decision and run counts from the backend', async () => {
    renderApp(<OverviewPage />, { routes: routes() });
    const card = (name) => screen.getByRole('article', { name: new RegExp(`^${name}:`) });
    await screen.findByRole('article', { name: /^Lead Intelligence Agent: Running/ });
    expect(within(card('Lead Intelligence Agent')).getByText('Analysing Priya Shah')).toBeInTheDocument();
    expect(within(card('Lead Intelligence Agent')).getByText(/4 succeeded/)).toBeInTheDocument();
    expect(card('Conversation Agent')).toHaveAccessibleName('Conversation Agent: Failed');
    expect(within(card('Conversation Agent')).getByText('The AI provider is temporarily unavailable')).toBeInTheDocument();
    expect(within(card('Follow-up Agent')).getByText(/Send follow-up 1 to Hannah Becker/)).toBeInTheDocument();
    expect(within(card('Follow-up Agent')).getByText(/2 queued/)).toBeInTheDocument();
    expect(within(card('Sales Intelligence Agent')).getByText('Daniel Okafor: waiting for your approval')).toBeInTheDocument();
    expect(within(card('Sales Intelligence Agent')).getByRole('link', { name: 'View lead' })).toHaveAttribute('href', '/leads/l1');
  });
});

describe('Insights', () => {
  it('shows proactive recommendations with reason and estimated impact', async () => {
    renderApp(<OverviewPage />, { routes: routes() });
    expect(await screen.findByText('Daniel Okafor is waiting for a reply')).toBeInTheDocument();
    expect(screen.getByText(/wrote 3 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated impact: \$300 potential deal/)).toBeInTheDocument();
  });

  it('shows AI pipeline analysis with the data behind it, and labels mock output honestly', async () => {
    renderApp(<OverviewPage />, { routes: routes() });
    await userEvent.click(await screen.findByRole('radio', { name: 'AI pipeline analysis' }));
    expect(await screen.findByText('Reply to 2 waiting leads')).toBeInTheDocument();
    expect(screen.getByText('High priority')).toBeInTheDocument();
    expect(screen.getByText(/mock AI \(rule-based\)/)).toBeInTheDocument();
    expect(screen.getByText(/Based on: Leads waiting for a reply\./)).toBeInTheDocument();
  });

  it('generates insights for the selected range on request', async () => {
    const { calls } = renderApp(<OverviewPage />, {
      routes: routes({ 'GET /api/dashboard/insights': { data: null }, 'POST /api/dashboard/insights': [201, insights] }),
    });
    await userEvent.click(await screen.findByRole('radio', { name: 'AI pipeline analysis' }));
    expect(await screen.findByText('No insights yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByText('Insights updated')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/dashboard/insights', body: { range: '30d' } });
  });
});

describe('Conversion funnel', () => {
  it('shows counts, share of all leads and stage-to-stage conversion, with a table view', async () => {
    renderApp(<OverviewPage />, { routes: routes() });
    expect(await screen.findByLabelText('Qualified: 6 leads, 50% of all leads, 75% of the previous stage')).toBeInTheDocument();
    expect(screen.getByText('83.3% moved on')).toBeInTheDocument();
    // Summary: biggest drop is New -> Qualified (50%).
    expect(screen.getByText('New → Qualifying')).toBeInTheDocument();
    const funnelCard = screen.getByText('Sales conversion funnel').closest('section');
    await userEvent.click(within(funnelCard).getByRole('button', { name: 'Table' }));
    const table = within(funnelCard).getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(8);
    expect(within(table).getByText('41.7%')).toBeInTheDocument();
  });
});

describe('Approvals', () => {
  it('shows what needs approval, the AI recommendation, reason and preview, and approves via the API', async () => {
    const { calls } = renderApp(<OverviewPage />, { routes: routes({ 'POST /api/approvals/:id/approve': { id: 'a2', status: 'APPROVED' } }) });
    expect(await screen.findByText('Send this reply now')).toBeInTheDocument();
    expect(screen.getByText('First reply to a new enquiry; asks 2 qualifying questions.')).toBeInTheDocument();
    expect(screen.getByText('Hi Daniel, weekly lawn maintenance is $45–$85.')).toBeInTheDocument();
    expect(screen.getByText('Decide whether to offer 10% off Weekly lawn maintenance (3+ properties)')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Review details' })[0]).toHaveAttribute('href', '/conversations/l1');

    await userEvent.click(screen.getByRole('button', { name: 'Approve discount request for Daniel Okafor' }));
    expect(await screen.findByText('Approved for Daniel Okafor')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').path).toBe('/api/approvals/a2/approve');
  });

  it('rejects via the API', async () => {
    const { calls } = renderApp(<OverviewPage />, { routes: routes({ 'POST /api/approvals/:id/reject': { id: 'a1', status: 'REJECTED' } }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject reply email for Daniel Okafor' }));
    expect(await screen.findByText('Rejected for Daniel Okafor')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').path).toBe('/api/approvals/a1/reject');
  });

  it('does not offer approve/reject to team members', async () => {
    renderApp(<OverviewPage />, { role: 'MEMBER', routes: routes() });
    expect(await screen.findByText('Send this reply now')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
    expect(screen.getAllByText('Only the owner can approve.')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Reject/ })).not.toBeInTheDocument();
  });
});

describe('Recent activity', () => {
  it('labels each event with its type and filters by category', async () => {
    const { calls } = renderApp(<OverviewPage />, { routes: routes() });
    expect(await screen.findByText('Scored 82/100 by AI')).toBeInTheDocument();
    expect(screen.getByText('Qualification', { selector: 'span' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'ai');
    expect(await screen.findByText('AI decided: waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('A reply draft is waiting for your approval.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/dashboard/activity').at(-1).query.category).toBe('ai');
  });
});
