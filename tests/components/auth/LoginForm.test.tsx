// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

function mockBrowser(opts: {
  signInPwResult?: { error: null | { message: string; code?: string } };
  signInOAuthResult?: { error: null | { message: string; code?: string } };
}) {
  const signInWithPassword = vi.fn().mockResolvedValue(
    opts.signInPwResult ?? { error: null },
  );
  const signInWithOAuth = vi.fn().mockResolvedValue(
    opts.signInOAuthResult ?? { error: null },
  );
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      auth: { signInWithPassword, signInWithOAuth },
    }),
  }));
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
  }));
  return { signInWithPassword, signInWithOAuth };
}

describe('LoginForm', () => {
  it('email/password submit calls signInWithPassword with the values', async () => {
    const { signInWithPassword } = mockBrowser({});
    const { LoginForm } = await import('@/components/auth/LoginForm');
    render(<LoginForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'a@b.com');
    await user.type(screen.getByLabelText(/senha/i), 'pw1234');
    await user.click(screen.getByRole('button', { name: /entrar/i }));
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.com', password: 'pw1234' });
  });

  it('Google button calls signInWithOAuth with provider google', async () => {
    const { signInWithOAuth } = mockBrowser({});
    const { LoginForm } = await import('@/components/auth/LoginForm');
    render(<LoginForm />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /google/i }));
    expect(signInWithOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'google' }),
    );
  });

  it('shows error when signInWithPassword returns invalid credentials', async () => {
    mockBrowser({ signInPwResult: { error: { message: 'Invalid login credentials' } } });
    const { LoginForm } = await import('@/components/auth/LoginForm');
    render(<LoginForm />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'a@b.com');
    await user.type(screen.getByLabelText(/senha/i), 'pw');
    await user.click(screen.getByRole('button', { name: /entrar/i }));
    expect(await screen.findByText(/email ou senha incorretos/i)).toBeTruthy();
  });

  it('renders a link to /forgot-password', async () => {
    mockBrowser({});
    const { LoginForm } = await import('@/components/auth/LoginForm');
    render(<LoginForm />);
    const link = screen.getByRole('link', { name: /esqueci minha senha/i });
    expect(link.getAttribute('href')).toBe('/forgot-password');
  });
});
