import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function mockSupabaseRpc(impl: (name: string, args: unknown) => unknown) {
  const rpc = vi.fn(impl);
  vi.doMock('@/lib/db/supabase-server', () => ({
    supabaseServer: () => ({ rpc }),
  }));
  return rpc;
}

describe('checkChatRateLimit', () => {
  it('returns { allowed: true } when RPC reports allowed', async () => {
    mockSupabaseRpc(() => ({ data: [{ allowed: true, retry_after_secs: 0 }], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('returns { allowed: false, retryAfterSecs } when RPC reports blocked', async () => {
    mockSupabaseRpc(() => ({ data: [{ allowed: false, retry_after_secs: 3600 }], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: false, retryAfterSecs: 3600 });
  });

  it('fails open when the RPC errors out', async () => {
    mockSupabaseRpc(() => ({ data: null, error: { message: 'boom' } }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('fails open when the RPC returns an empty array', async () => {
    mockSupabaseRpc(() => ({ data: [], error: null }));
    const { checkChatRateLimit } = await import('@/lib/rate-limit');
    await expect(checkChatRateLimit()).resolves.toEqual({ allowed: true });
  });

  it('passes the documented limits to the RPC', async () => {
    const rpc = mockSupabaseRpc(() => ({ data: [{ allowed: true, retry_after_secs: 0 }], error: null }));
    const { checkChatRateLimit, RATE_LIMIT_PER_MIN, RATE_LIMIT_PER_HOUR } = await import('@/lib/rate-limit');
    await checkChatRateLimit();
    expect(rpc).toHaveBeenCalledWith('check_rate_limit', {
      p_endpoint: 'chat',
      p_per_min: RATE_LIMIT_PER_MIN,
      p_per_hour: RATE_LIMIT_PER_HOUR,
    });
  });
});
