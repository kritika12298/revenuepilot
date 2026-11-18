import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { AutonomyPage } from './AutonomyPage.jsx';
import { IntegrationsPage } from './IntegrationsPage.jsx';
import { KnowledgePage } from './KnowledgePage.jsx';
import { PublicFormPage } from './PublicFormPage.jsx';
import { GlobalSearch } from '../components/GlobalSearch.jsx';
import { NotificationBell } from '../components/NotificationBell.jsx';

afterEach(() => vi.unstubAllGlobals());

const policy = {
  autoScoreLeads: true,
  autoGenerateResponses: true,
  autoSendResponses: false,
  autoScheduleFollowUps: true,
  autoApproveFollowUps: false,
  autoBookAppointments: false,
  maxAutoEmailsPerDay: 50,
  updatedAt: new Date().toISOString(),
};
const autonomy = { policy, lockedApprovals: { discounts: true, quotations: true, contracts: true, customPricing: true } };

describe('Autonomy control center', () => {
  it('shows server-enforced settings and saves a toggle', async () => {
    const { calls } = renderApp(<AutonomyPage />, {
      routes: {
        'GET /api/autonomy': autonomy,
        'PUT /api/autonomy': ({ body }) => ({ ...autonomy, policy: { ...policy, ...body } }),
        'GET /api/agent-runs': { data: [], meta: { page: 1, pageSize: 5, total: 0, totalPages: 0 } },
      },
    });
    const send = await screen.findByRole('switch', { name: 'Send replies without my approval' });
    expect(send).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Discounts').closest('li')).toHaveTextContent('Approval required');
    await userEvent.click(send);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ autoSendResponses: true }));
  });

  it('is read-only for members', async () => {
    renderApp(<AutonomyPage />, { role: 'MEMBER', routes: { 'GET /api/autonomy': autonomy, 'GET /api/agent-runs': { data: [], meta: { total: 0 } } } });
    expect(await screen.findByRole('switch', { name: 'Score new leads automatically' })).toBeDisabled();
  });
});

const integration = (provider, name, status, extra = {}) => ({
  provider, name, description: `${name} description`, status, mode: 'live', requirements: [], config: {}, lastSyncAt: null, lastError: null, actions: [], ...extra,
});

describe('Integration hub', () => {
  it('shows honest statuses, including mock mode', async () => {
    renderApp(<IntegrationsPage />, {
      routes: {
        'GET /api/integrations': {
          data: [
            integration('godaddy_domains', 'GoDaddy Domains', 'ERROR', { lastError: 'Something failed', actions: ['connect_token', 'test', 'disconnect'] }),
            integration('claude', 'Claude API', 'MOCK', { mode: 'mock', note: 'Mock AI is active: agents use rule-based stand-ins and no Claude calls are made.' }),
            integration('google_calendar', 'Google Calendar', 'DISABLED', { note: 'Not available on this server.' }),
            integration('godaddy_websites', 'GoDaddy Websites + Marketing', 'AVAILABLE', { mode: 'embed', config: { formUrl: '/f/evergreen', embed: '<iframe src="{ORIGIN}/f/evergreen"></iframe>' } }),
          ],
        },
      },
    });
    const card = async (name) => (await screen.findByRole('heading', { name })).closest('section, article, div.rounded-xl');
    expect(await card('Claude API')).toHaveTextContent('Mock mode');
    expect(await card('GoDaddy Domains')).toHaveTextContent('Something failed');
    expect(await card('Google Calendar')).toHaveTextContent('Not available');
    const websites = await card('GoDaddy Websites + Marketing');
    expect(websites).toHaveTextContent('Embed available');
    expect(websites).not.toHaveTextContent('Connected');
    expect(websites).toHaveTextContent('Last form enquiry');
  });
});

describe('Public enquiry form', () => {
  it('submits an enquiry and shows the confirmation', async () => {
    const { calls } = renderApp(<PublicFormPage />, {
      route: '/f/evergreen',
      path: '/f/:slug',
      routes: {
        'GET /api/public/forms/evergreen': { business: { name: 'Evergreen Landscaping Co.' }, businessName: 'Evergreen Landscaping Co.', consentText: 'Email me about my enquiry.' },
        'POST /api/public/forms/evergreen/leads': [201, { message: 'Thanks! We will be in touch shortly.' }],
      },
    });
    await userEvent.type(await screen.findByLabelText('Name'), 'Alex Rivera');
    await userEvent.type(screen.getByLabelText('Email', { exact: true }), 'alex@example.com');
    await userEvent.type(screen.getByLabelText('How can we help?'), 'I need landscaping work for my residential property.');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Send enquiry' }));
    expect(await screen.findByText('Thanks! We will be in touch shortly.')).toHaveAttribute('role', 'status');
    const post = calls.find((c) => c.method === 'POST');
    expect(post.body).toMatchObject({ name: 'Alex Rivera', email: 'alex@example.com', consent: true, website: '' });
  });
});

describe('Global search', () => {
  it('searches leads and messages after two characters', async () => {
    const { calls } = renderApp(<GlobalSearch />, {
      routes: {
        'GET /api/search': {
          leads: [{ id: 'l1', name: 'Daniel Okafor', email: 'daniel@example.com', status: 'QUALIFIED' }],
          messages: [{ id: 'm1', lead: { id: 'l1', name: 'Daniel Okafor' }, snippet: '…weekly mowing and edging…', direction: 'INBOUND', createdAt: new Date().toISOString() }],
        },
      },
    });
    const box = screen.getByRole('combobox', { name: 'Search leads and conversations' });
    await userEvent.type(box, 'm');
    await userEvent.type(box, 'ow');
    const list = await screen.findByRole('listbox');
    expect(await within(list).findByText('…weekly mowing and edging…')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/api/search').every((c) => c.query.q.length >= 2)).toBe(true);
  });
});

describe('Notification centre', () => {
  it('shows the unread count and marks everything read', async () => {
    let unread = 2;
    const { calls } = renderApp(<NotificationBell />, {
      routes: {
        'GET /api/notifications/unread-count': () => ({ count: unread }),
        'GET /api/notifications': { data: [{ id: 'n1', priority: 'URGENT', reason: 'RECOMMENDATION', message: 'Grace Kim is waiting for a reply.', readAt: null, createdAt: new Date().toISOString(), lead: { id: 'l2', name: 'Grace Kim' } }] },
        'POST /api/notifications/read-all': () => { unread = 0; return { updated: 2 }; },
      },
    });
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 unread' });
    await userEvent.click(bell);
    expect(await screen.findByText('Grace Kim is waiting for a reply.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Mark all read/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/notifications/read-all')).toBe(true));
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });
});

describe('Website knowledge review', () => {
  it('lists extracted items with their evidence and approves one', async () => {
    const item = {
      id: 'k1', type: 'SERVICE', title: 'Lawn maintenance', content: 'Weekly mowing, edging, blowing and weed control.',
      priceText: 'Weekly lawn maintenance costs $45 to $85 per visit depending on lot size.', source: 'WEBSITE', status: 'PENDING_REVIEW',
      sourceUrl: 'https://evergreen-landscaping.test/services', evidence: 'Weekly mowing, edging, blowing and weed control.', createdAt: new Date().toISOString(),
    };
    const { calls } = renderApp(<KnowledgePage />, {
      routes: {
        'GET /api/website': {
          website: { id: 'w1', url: 'https://evergreen-landscaping.test/', status: 'COMPLETED', pagesFetched: 4, pages: [], summary: 'Family-owned landscaping company.', lastSyncAt: new Date().toISOString() },
          counts: { PENDING_REVIEW: 1 },
          demoHosts: ['evergreen-landscaping.test'],
        },
        'GET /api/knowledge': { data: [item] },
        'PATCH /api/knowledge/k1': ({ body }) => ({ ...item, ...body }),
      },
    });
    expect(await screen.findByText('Lawn maintenance')).toBeInTheDocument();
    expect(screen.getByText(/\$45 to \$85 per visit/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'APPROVED' }));
  });
});
