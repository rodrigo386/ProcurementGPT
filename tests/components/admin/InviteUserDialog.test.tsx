// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ refresh: vi.fn() }),
  }));
});
afterEach(() => cleanup());

describe('InviteUserDialog', () => {
  it('submit calls POST /api/admin/users with the email', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchSpy);
    const { InviteUserDialog } = await import('@/components/admin/InviteUserDialog');
    render(<InviteUserDialog open onOpenChange={() => {}} />);
    await userEvent.type(screen.getByLabelText(/email/i), 'novo@empresa.com');
    await userEvent.click(screen.getByRole('button', { name: /enviar convite/i }));
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/admin/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'novo@empresa.com' }),
      }),
    );
  });

  it('renders inline error when API responds 409', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'user_already_exists' }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { InviteUserDialog } = await import('@/components/admin/InviteUserDialog');
    render(<InviteUserDialog open onOpenChange={() => {}} />);
    await userEvent.type(screen.getByLabelText(/email/i), 'existing@example.com');
    await userEvent.click(screen.getByRole('button', { name: /enviar convite/i }));
    expect(await screen.findByText(/já está cadastrado/i)).toBeTruthy();
  });
});
