import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { LeadDetailPage } from './LeadDetailPage.jsx';
import { RevenuePage } from './RevenuePage.jsx';
import { SimulatorPage } from './SimulatorPage.jsx';
import { AiActivityPage } from './AiActivityPage.jsx';
// Real API responses captured from the seeded demo (see apps/api/prisma/seed.js).
import lead from '../test/fixtures/lead.json';
import revenue from '../test/fixtures/revenue.json';
import runs from '../test/fixtures/runs.json';
import simulation from '../test/fixtures/sim.json';

afterEach(() => vi.unstubAllGlobals());

const empty = { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };
const leadRoutes = (overrides = {}) => ({
  [`GET /api/leads/${lead.id}`]: lead,
  [`GET /api/leads/${lead.id}/events`]: empty,
  [`GET /api/leads/${lead.id}/agent-runs`]: runs,
  [`GET /api/agent-runs/${runs.data[0].id}`]: { ...runs.data[0], toolCalls: [], childRuns: [] },
  'GET /api/business/members': { data: [{ id: 'u1', name: 'Maria Lopez', role: 'OWNER' }, { id: 'u2', name: 'Sam Patel', role: 'MEMBER' }] },
  'GET /api/ai/status': { mode: 'mock', model: 'mock' },
  ...overrides,
});

describe('Lead 360° profile', () => {
  it('shows the profile, an honest unknown deal value, and saves an owner value and an assignee', async () => {
    const { calls } = renderApp(<LeadDetailPage />, {
      route: `/leads/${lead.id}`,
      path: '/leads/:id',
      routes: leadRoutes({ [`PATCH /api/leads/${lead.id}`]: ({ body }) => ({ ...lead, ...body, assignedTo: body.assignedToId ? { id: 'u2', name: 'Sam Patel' } : null }) }),
    });
    expect(await screen.findByRole('heading', { name: lead.name })).toBeInTheDocument();
    const dealCard = screen.getByText('Potential deal value').closest('section, div.rounded-xl');
    expect(within(dealCard).getByText('Unknown')).toBeInTheDocument();
    expect(within(dealCard).getByText(lead.dealValue.basis)).toBeInTheDocument();

    await userEvent.click(within(dealCard).getByRole('button', { name: 'Set value' }));
    await userEvent.type(within(dealCard).getByLabelText('Value ($)'), '1200');
    await userEvent.click(within(dealCard).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.body.dealValueCents != null)?.body).toEqual({ dealValueCents: 120000 }));

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Assigned to' }), 'u2');
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && 'assignedToId' in c.body)?.body).toEqual({ assignedToId: 'u2' }));
  });

  it('shows the AI decision timeline with the run trigger and labels seeded demo runs honestly', async () => {
    renderApp(<LeadDetailPage />, { route: `/leads/${lead.id}`, path: '/leads/:id', routes: leadRoutes() });
    await userEvent.click(await screen.findByRole('radio', { name: 'AI decisions' }).catch(() => screen.findByRole('button', { name: 'AI decisions' })));
    expect(await screen.findByText('Lead Intelligence Agent')).toBeInTheDocument();
    expect(screen.getByText(/Analysed the enquiry/)).toBeInTheDocument();
    expect(screen.getAllByText(/Demo data \(seeded\)/).length).toBeGreaterThan(0);
  });

  it('hides owner-only controls from members', async () => {
    renderApp(<LeadDetailPage />, { role: 'MEMBER', route: `/leads/${lead.id}`, path: '/leads/:id', routes: leadRoutes() });
    expect(await screen.findByRole('heading', { name: lead.name })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Assigned to' })).not.toBeInTheDocument();
  });
});

describe('Revenue intelligence', () => {
  it('labels values as estimates and shows the methodology and data-sufficiency note', async () => {
    renderApp(<RevenuePage />, { routes: { 'GET /api/revenue': revenue } });
    expect(await screen.findByText('Pipeline value')).toBeInTheDocument();
    expect(screen.getByText(/Estimates, not guaranteed revenue/)).toBeInTheDocument();
    expect(screen.getByText(revenue.disclaimer)).toBeInTheDocument();
    expect(screen.getByText('How predictions are calculated')).toBeInTheDocument();
    if (!revenue.dataSufficiency.sufficient) expect(screen.getByText((t) => t.includes('Not enough closed leads yet'))).toBeInTheDocument();
    // Every at-risk lead is listed with its reason.
    for (const o of revenue.atRisk.leads) expect(screen.getAllByText(o.lead.name).length).toBeGreaterThan(0);
  });

  it('re-queries when the date range changes', async () => {
    const { calls } = renderApp(<RevenuePage />, { routes: { 'GET /api/revenue': revenue } });
    await screen.findByText('Pipeline value');
    await userEvent.click(screen.getByRole('radio', { name: '90 days' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/revenue' && c.query.range === '90d')).toBe(true));
  });
});

describe('Follow-up strategy simulator', () => {
  it('runs a scenario, labels the result as a simulation and refuses to estimate on small samples', async () => {
    const { calls } = renderApp(<SimulatorPage />, { routes: { 'POST /api/simulations': simulation, 'GET /api/business': { id: 'b1', commsPrefs: {} } } });
    await userEvent.click(await screen.findByRole('button', { name: /Run simulation/ }));
    expect(await screen.findByText(/Simulation, not an actual result/)).toBeInTheDocument();
    expect(screen.getByText((t) => t.includes('Need at least 5 leads in each group'))).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/simulations').body).toMatchObject({ scenario: 'RESPONSE_TIME' });
    // Nothing was changed: running a simulation never writes settings.
    expect(calls.some((c) => ['PATCH', 'PUT'].includes(c.method))).toBe(false);
  });
});

describe('AI activity', () => {
  it('lists agent runs and filters by agent', async () => {
    const { calls } = renderApp(<AiActivityPage />, { routes: { 'GET /api/agent-runs': runs } });
    expect(await screen.findByText('Lead Intelligence Agent')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), screen.getAllByRole('option').find((o) => /Policy/.test(o.textContent)).value);
    await waitFor(() => expect(calls.some((c) => c.path === '/api/agent-runs' && c.query.agent === 'policy')).toBe(true));
  });
});
