import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/render.jsx';
import { AppShell } from './AppShell.jsx';

afterEach(() => vi.unstubAllGlobals());

describe('mobile navigation', () => {
  it('opens as a modal dialog, traps focus, and closes on Escape returning focus to the menu button', async () => {
    renderApp(<AppShell />, { routes: { 'GET /api/ai/status': { mode: 'mock' }, 'GET /api/approvals': { data: [], meta: { total: 0 } }, 'GET /api/notifications/unread-count': { count: 0 } } });
    const opener = await screen.findByRole('button', { name: 'Open menu' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Main menu' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });
});
