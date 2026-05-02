import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function mockSupabaseServer(opts: {
  user?: { id: string; email: string } | null;
  profile?: { id: string; role: 'user' | 'admin'; display_name: string | null } | null;
  profileError?: { message: string } | null;
}) {
  vi.doMock('@/lib/db/supabase-server', () => ({
    supabaseServer: () => ({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: opts.user ?? null }, error: null }),
      },
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: opts.profile ?? null,
                error: opts.profileError ?? null,
              }),
          }),
        }),
      })),
    }),
  }));
}

describe('lib/auth', () => {
  it('getCurrentUser returns the user when session is valid', async () => {
    mockSupabaseServer({ user: { id: 'u1', email: 'a@b.com' } });
    const { getCurrentUser } = await import('@/lib/auth');
    const u = await getCurrentUser();
    expect(u?.id).toBe('u1');
  });

  it('getCurrentUser returns null when no session', async () => {
    mockSupabaseServer({ user: null });
    const { getCurrentUser } = await import('@/lib/auth');
    expect(await getCurrentUser()).toBeNull();
  });

  it('requireUser throws NotAuthenticated when no session', async () => {
    mockSupabaseServer({ user: null });
    const { requireUser, NotAuthenticated } = await import('@/lib/auth');
    await expect(requireUser()).rejects.toBeInstanceOf(NotAuthenticated);
  });

  it('getProfile returns the profile row when present', async () => {
    mockSupabaseServer({
      profile: { id: 'u1', role: 'user', display_name: null },
    });
    const { getProfile } = await import('@/lib/auth');
    const p = await getProfile('u1');
    expect(p?.role).toBe('user');
  });

  it('getProfile returns null on error or missing row', async () => {
    mockSupabaseServer({ profile: null, profileError: { message: 'not found' } });
    const { getProfile } = await import('@/lib/auth');
    expect(await getProfile('u1')).toBeNull();
  });
});
