// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  }));
});
afterEach(() => cleanup());

const sampleUsers = [
  { id: 'u1', email: 'admin@example.com', role: 'admin' as const, last_sign_in_at: '2026-05-03T10:00:00Z', session_count: 12, created_at: '2026-04-01T10:00:00Z' },
  { id: 'u2', email: 'user@example.com', role: 'user' as const, last_sign_in_at: '2026-05-02T08:00:00Z', session_count: 3, created_at: '2026-04-15T10:00:00Z' },
  { id: 'u3', email: 'pending@example.com', role: 'user' as const, last_sign_in_at: null, session_count: 0, created_at: '2026-05-03T11:00:00Z' },
];

describe('UsersTable', () => {
  it('renders one row per user with email and a role pill', async () => {
    const { UsersTable } = await import('@/components/admin/UsersTable');
    render(<UsersTable users={sampleUsers} currentUserId="u1" />);
    expect(screen.getByText('admin@example.com')).toBeTruthy();
    expect(screen.getByText('user@example.com')).toBeTruthy();
    expect(screen.getByText('pending@example.com')).toBeTruthy();
    expect(screen.getAllByText(/admin/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/convite enviado/i)).toBeTruthy();
  });

  it('row menu opens and reveals Promote action for a non-admin user', async () => {
    const { UsersTable } = await import('@/components/admin/UsersTable');
    render(<UsersTable users={sampleUsers} currentUserId="u1" />);
    const triggers = screen.getAllByRole('button', { name: /ações/i });
    // u2 is the second non-pending user row
    await userEvent.click(triggers[1]!);
    expect(await screen.findByText(/promover a admin/i)).toBeTruthy();
  });

  it('"+ Convidar usuário" button opens the InviteUserDialog', async () => {
    const { UsersTable } = await import('@/components/admin/UsersTable');
    render(<UsersTable users={sampleUsers} currentUserId="u1" />);
    await userEvent.click(screen.getByRole('button', { name: /convidar usuário/i }));
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
  });
});
