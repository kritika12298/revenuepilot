import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { FollowUpsPage } from './FollowUpsPage.jsx';

afterEach(() => vi.unstubAllGlobals());

const followUp = {
  id: 'f1',
  step: 1,
  status: 'PENDING_APPROVAL',
  scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
  lead: { id: 'l1', name: 'Hannah Becker', status: 'CONTACTED', consentEmail: true },
  message: {
    id: 'm1',
    subject: 'Sprinkler repair',
    body: 'Hi Hannah,\n\nJust checking in on your sprinkler repair.',
    status: 'PENDING_APPROVAL',
    approvals: [{ id: 'a1', status: 'PENDING' }],
    delivery: null,
  },
};

const page = (data) => ({ data, meta: { page: 1, pageSize: 20, total: data.length, totalPages: 1 } });

describe('Follow-ups', () => {
  it('lists upcoming follow-ups with a message preview and switches tabs', async () => {
    const { calls } = renderApp(<FollowUpsPage />, {
      routes: { 'GET /api/follow-ups': ({ url }) => (url.searchParams.get('status') === 'SENT' ? page([]) : page([followUp])) },
    });
    expect(await screen.findByText('Hannah Becker')).toBeInTheDocument();
    expect(screen.getByText('Just checking in on your sprinkler repair.')).toBeInTheDocument();
    expect(screen.getByText('Needs approval')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/follow-ups').query.status).toBe('DRAFTING,PENDING_APPROVAL,SCHEDULED');

    await userEvent.click(screen.getByRole('radio', { name: 'Sent' }));
    expect(await screen.findByText('No sent follow-ups')).toBeInTheDocument();
  });

  it('cancels a follow-up with a reason', async () => {
    const { calls } = renderApp(<FollowUpsPage />, {
      routes: {
        'GET /api/follow-ups': page([followUp]),
        'POST /api/follow-ups/:id/cancel': { ...followUp, status: 'CANCELLED' },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel follow-up to Hannah Becker' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this follow-up?' });
    await userEvent.type(within(dialog).getByLabelText('Reason (optional)'), 'Spoke on the phone');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel follow-up' }));
    expect(await screen.findByText('Follow-up cancelled')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/follow-ups/f1/cancel', body: { reason: 'Spoke on the phone' } });
  });

  it('reschedules with a preset delay inside working hours', async () => {
    const { calls } = renderApp(<FollowUpsPage />, {
      routes: {
        'GET /api/follow-ups': page([followUp]),
        'POST /api/follow-ups/:id/reschedule': { ...followUp, scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule follow-up to Hannah Becker' }));
    const dialog = screen.getByRole('dialog', { name: 'Reschedule follow-up' });
    await userEvent.click(within(dialog).getByRole('radio', { name: '+3 days' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(await screen.findByText('Follow-up rescheduled')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ delayHours: 72, respectWorkingHours: true });
  });

  it('lets owners approve a draft from the preview, but not members', async () => {
    const { calls } = renderApp(<FollowUpsPage />, {
      routes: { 'GET /api/follow-ups': page([followUp]), 'POST /api/approvals/:id/approve': { id: 'a1', status: 'APPROVED' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview follow-up to Hannah Becker' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Follow-up approved')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST').path).toBe('/api/approvals/a1/approve');
  });

  it('hides approval for team members', async () => {
    renderApp(<FollowUpsPage />, { role: 'MEMBER', routes: { 'GET /api/follow-ups': page([followUp]) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Preview follow-up to Hannah Becker' }));
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
