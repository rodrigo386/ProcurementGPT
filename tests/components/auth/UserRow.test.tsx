// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => cleanup());

function mockBrowser(email: string | null) {
  const signOut = vi.fn().mockResolvedValue({ error: null });
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: { user: email ? { id: 'u1', email } : null },
          error: null,
        }),
        signOut,
      },
      // UserRow also queries profiles to decide whether to render the Admin link
      from: vi.fn().mockReturnValue({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { role: 'user' }, error: null }),
          }),
        }),
      }),
    }),
  }));
  const refresh = vi.fn();
  const push = vi.fn();
  vi.doMock('next/navigation', () => ({
    useRouter: () => ({ refresh, push }),
  }));
  return { signOut, refresh, push };
}

describe('UserRow', () => {
  it('renders the user email', async () => {
    mockBrowser('a@b.com');
    const { UserRow } = await import('@/components/auth/UserRow');
    render(<UserRow />);
    expect(await screen.findByText('a@b.com')).toBeTruthy();
  });

  it('Sair calls signOut and refreshes', async () => {
    const { signOut, refresh } = mockBrowser('a@b.com');
    const { UserRow } = await import('@/components/auth/UserRow');
    render(<UserRow />);
    await screen.findByText('a@b.com');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /sair/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalled();
  });
});
