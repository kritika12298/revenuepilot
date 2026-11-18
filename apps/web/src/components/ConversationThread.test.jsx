import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { ConversationThread } from './ConversationThread.jsx';

afterEach(() => vi.unstubAllGlobals());

const lead = {
  id: 'l1',
  name: 'Daniel Okafor',
  conversations: [
    {
      messages: [
        { id: 'm1', direction: 'INBOUND', author: 'LEAD', status: 'RECEIVED', body: 'Do you do weekly mowing?', createdAt: '2026-11-17T10:00:00Z' },
        { id: 'm2', direction: 'OUTBOUND', author: 'AI', status: 'PENDING_APPROVAL', subject: 'Re: mowing', body: 'Hi Daniel, yes we do.', createdAt: '2026-11-17T10:05:00Z' },
        { id: 'm3', direction: 'OUTBOUND', author: 'OWNER', status: 'SENT', body: 'Earlier note', sentAt: '2026-11-16T10:05:00Z', createdAt: '2026-11-16T10:05:00Z' },
      ],
    },
  ],
  approvals: [{ id: 'a1', messageId: 'm2', type: 'OUTBOUND_MESSAGE' }],
};

describe('ConversationThread', () => {
  it('shows history in order and marks AI drafts that need approval', async () => {
    renderApp(<ConversationThread lead={lead} timeZone="UTC" />);
    const articles = await screen.findAllByRole('article');
    expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual(['You message', 'Lead message', 'AI assistant message']);
    expect(screen.getByText('AI generated')).toBeInTheDocument();
    expect(screen.getByText('Needs approval')).toBeInTheDocument();
    expect(screen.getByText(/Sent/)).toBeInTheDocument();
  });

  it('lets the owner edit and approve a draft in place', async () => {
    const { calls } = renderApp(<ConversationThread lead={lead} timeZone="UTC" />, { routes: { 'POST /api/approvals/:id/approve': { id: 'a1', status: 'APPROVED' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit before approving');
    await userEvent.clear(box);
    await userEvent.type(box, 'Hi Daniel, yes! What are the addresses?');
    await userEvent.click(screen.getByRole('button', { name: 'Save & approve' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/approvals/a1/approve', body: { body: 'Hi Daniel, yes! What are the addresses?' } });
  });

  it('does not offer approval to team members', async () => {
    renderApp(<ConversationThread lead={lead} timeZone="UTC" />, { role: 'MEMBER' });
    expect(await screen.findByText('Waiting for the owner to approve.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});
