// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => cleanup());

function mockBrowser() {
  const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({ auth: { resetPasswordForEmail } }),
  }));
  return { resetPasswordForEmail };
}

describe('ForgotPasswordForm', () => {
  it('submit calls resetPasswordForEmail with the email', async () => {
    const { resetPasswordForEmail } = mockBrowser();
    const { ForgotPasswordForm } = await import('@/components/auth/ForgotPasswordForm');
    render(<ForgotPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /enviar link/i }));
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(resetPasswordForEmail.mock.calls[0]?.[0]).toBe('a@b.com');
  });

  it('shows success state after submit', async () => {
    mockBrowser();
    const { ForgotPasswordForm } = await import('@/components/auth/ForgotPasswordForm');
    render(<ForgotPasswordForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'a@b.com');
    await user.click(screen.getByRole('button', { name: /enviar link/i }));
    expect(await screen.findByText(/verifique seu email/i)).toBeTruthy();
  });
});
