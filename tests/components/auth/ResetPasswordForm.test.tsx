// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => cleanup());

function mockBrowser(opts: {
  user?: { id: string } | null;
  updateResult?: { error: null | { message: string } };
}) {
  const updateUser = vi.fn().mockResolvedValue(opts.updateResult ?? { error: null });
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      auth: {
        updateUser,
        getUser: vi.fn().mockResolvedValue({ data: { user: opts.user ?? null }, error: null }),
      },
    }),
  }));
  const push = vi.fn();
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ push, refresh: vi.fn() }),
  }));
  return { updateUser, push };
}

describe('ResetPasswordForm', () => {
  it('submit with matching passwords calls updateUser and redirects', async () => {
    const { updateUser, push } = mockBrowser({ user: { id: 'u1' } });
    const { ResetPasswordForm } = await import('@/components/auth/ResetPasswordForm');
    render(<ResetPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^nova senha/i), 'novaSenha1');
    await user.type(screen.getByLabelText(/confirmar/i), 'novaSenha1');
    await user.click(screen.getByRole('button', { name: /redefinir/i }));
    expect(updateUser).toHaveBeenCalledWith({ password: 'novaSenha1' });
    // give the promise microtask a tick to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(push).toHaveBeenCalledWith('/chat');
  });

  it('blocks submit when passwords do not match', async () => {
    const { updateUser } = mockBrowser({ user: { id: 'u1' } });
    const { ResetPasswordForm } = await import('@/components/auth/ResetPasswordForm');
    render(<ResetPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^nova senha/i), 'aaaa');
    await user.type(screen.getByLabelText(/confirmar/i), 'bbbb');
    await user.click(screen.getByRole('button', { name: /redefinir/i }));
    expect(updateUser).not.toHaveBeenCalled();
    expect(await screen.findByText(/não coincidem/i)).toBeTruthy();
  });

  it('shows "request new link" CTA when there is no session', async () => {
    mockBrowser({ user: null });
    const { ResetPasswordForm } = await import('@/components/auth/ResetPasswordForm');
    render(<ResetPasswordForm />);
    expect(await screen.findByText(/solicite um novo link|solicitar novo link/i)).toBeTruthy();
  });
});
