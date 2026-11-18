import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { LeadsPage } from './LeadsPage.jsx';

afterEach(() => vi.unstubAllGlobals());

const lead = (over) => ({
  id: 'l1',
  name: 'Daniel Okafor',
  email: 'daniel@example.com',
  company: 'Okafor Property',
  source: 'WEB_FORM',
  status: 'QUALIFIED',
  score: 82,
  createdAt: new Date().toISOString(),
  lastContactAt: null,
  ...over,
});

describe('Leads', () => {
  it('renders leads with status and score, and passes filters to the API', async () => {
    const { calls } = renderApp(<LeadsPage />, {
      routes: {
        'GET /api/leads': ({ url }) => ({
          data: url.searchParams.get('status') === 'WON' ? [lead({ id: 'l2', name: 'Tom Whitaker', status: 'WON', score: 90 })] : [lead()],
          meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
        }),
      },
    });
    expect(await screen.findByText('Daniel Okafor')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Qualified')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Lead score' })).toHaveAttribute('aria-valuenow', '82');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'WON');
    expect(await screen.findByText('Tom Whitaker')).toBeInTheDocument();
    const leadCalls = () => calls.filter((c) => c.path === '/api/leads');
    expect(leadCalls().at(-1).query).toMatchObject({ status: 'WON', sort: 'createdAt', order: 'desc', page: '1' });

    await userEvent.type(screen.getByLabelText('Search leads'), 'tom');
    await waitFor(() => expect(leadCalls().at(-1).query.q).toBe('tom'));
  });

  it('distinguishes "no leads yet" from "no matches"', async () => {
    renderApp(<LeadsPage />, {
      route: '/?status=LOST',
      routes: { 'GET /api/leads': { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } } },
    });
    expect(await screen.findByText('No leads match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(await screen.findByText('No leads yet')).toBeInTheDocument();
  });

  it('shows field errors from the API when adding a lead', async () => {
    renderApp(<LeadsPage />, {
      routes: {
        'GET /api/leads': { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } },
        'POST /api/leads': [400, { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: [{ path: 'email', message: 'Invalid email address' }] } }],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add lead' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Sam');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add lead' }).at(-1));
    expect(await screen.findByText('Invalid email address')).toBeInTheDocument();
  });
});
