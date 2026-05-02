import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  vi.resetModules();
});

function makeReq(url: string) {
  // Minimal NextRequest stand-in; middleware reads .nextUrl, .url, .cookies
  const u = new URL(url);
  return {
    nextUrl: u,
    url: url,
    cookies: { get: () => undefined },
  } as unknown as import('next/server').NextRequest;
}

function mockSsr(session: unknown | null) {
  vi.doMock('@supabase/ssr', () => ({
    createServerClient: () => ({
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
      },
    }),
  }));
}

describe('middleware', () => {
  it('redirects unauthenticated /chat to /login with next param', async () => {
    mockSsr(null);
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeReq('http://localhost:3000/chat'));
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).toContain('next=%2Fchat');
  });

  it('passes through authenticated /chat (no redirect)', async () => {
    mockSsr({ user: { id: 'u1' } });
    const { middleware } = await import('@/middleware');
    const res = await middleware(makeReq('http://localhost:3000/chat'));
    // Pass-through is NextResponse.next() — status 200, no Location
    expect(res.headers.get('location')).toBeNull();
  });

  it('matcher config gates /chat and /admin only (not /api/chat)', async () => {
    const { config } = await import('@/middleware');
    const matchers = (config.matcher as string[]) ?? [];
    expect(matchers.some((m) => /\/chat/.test(m))).toBe(true);
    expect(matchers.some((m) => /\/admin/.test(m))).toBe(true);
    expect(matchers.some((m) => /\/api\/chat/.test(m))).toBe(false);
  });
});
