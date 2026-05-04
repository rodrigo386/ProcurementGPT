import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function mockSupabase(opts: { selectResult?: unknown; upsertError?: unknown } = {}) {
  const single = vi.fn().mockResolvedValue({
    data: opts.selectResult === undefined ? { id: 'sess-1' } : opts.selectResult,
    error: null,
  });
  const upsert = vi.fn().mockResolvedValue({ error: opts.upsertError ?? null });

  const from = vi.fn((table: string) => {
    if (table === 'sessions') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: single,
            })),
          })),
        })),
      };
    }
    if (table === 'message_feedback') {
      return { upsert };
    }
    throw new Error(`unexpected table ${table}`);
  });

  vi.doMock('@/lib/db/supabase-server', () => ({
    supabaseServer: () => ({ from }),
  }));
  return { upsert, single };
}

describe('recordFeedback', () => {
  it('returns { ok: false, status: 404 } when the session does not belong to the user', async () => {
    mockSupabase({ selectResult: null });
    vi.doMock('@/lib/observability/langfuse', () => ({
      scoreTrace: vi.fn(),
    }));
    const { recordFeedback } = await import('@/lib/feedback');
    const r = await recordFeedback({
      userId: 'u1',
      sessionId: '11111111-1111-1111-1111-111111111111',
      traceId: 'tr-1',
      rating: 'up',
    });
    expect(r).toEqual({ ok: false, status: 404 });
  });

  it('UPSERTs the row and fires scoreTrace with value=1 on 👍', async () => {
    const { upsert } = mockSupabase();
    const scoreTrace = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/observability/langfuse', () => ({ scoreTrace }));
    const { recordFeedback } = await import('@/lib/feedback');
    const r = await recordFeedback({
      userId: 'u1',
      sessionId: 'sess-1',
      traceId: 'tr-1',
      rating: 'up',
    });
    expect(r).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        session_id: 'sess-1',
        trace_id: 'tr-1',
        rating: 'up',
      }),
      expect.objectContaining({ onConflict: 'user_id,trace_id' }),
    );
    // scoreTrace runs fire-and-forget (void); we need a microtask flush
    await new Promise((r) => setTimeout(r, 10));
    expect(scoreTrace).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'tr-1', name: 'user-feedback', value: 1 }),
    );
  });

  it('fires scoreTrace with value=-1 and comment on 👎+comment', async () => {
    mockSupabase();
    const scoreTrace = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/lib/observability/langfuse', () => ({ scoreTrace }));
    const { recordFeedback } = await import('@/lib/feedback');
    await recordFeedback({
      userId: 'u1',
      sessionId: 'sess-1',
      traceId: 'tr-1',
      rating: 'down',
      comment: 'irrelevante',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(scoreTrace).toHaveBeenCalledWith({
      traceId: 'tr-1',
      name: 'user-feedback',
      value: -1,
      comment: 'irrelevante',
    });
  });

  it('still returns ok when scoreTrace throws (Langfuse failure does not block DB save)', async () => {
    mockSupabase();
    vi.doMock('@/lib/observability/langfuse', () => ({
      scoreTrace: vi.fn().mockRejectedValue(new Error('langfuse down')),
    }));
    const { recordFeedback } = await import('@/lib/feedback');
    const r = await recordFeedback({
      userId: 'u1',
      sessionId: 'sess-1',
      traceId: 'tr-1',
      rating: 'up',
    });
    expect(r).toEqual({ ok: true });
  });

  it('returns { ok: false, status: 500 } when the UPSERT fails', async () => {
    mockSupabase({ upsertError: { message: 'db boom' } });
    vi.doMock('@/lib/observability/langfuse', () => ({ scoreTrace: vi.fn() }));
    const { recordFeedback } = await import('@/lib/feedback');
    const r = await recordFeedback({
      userId: 'u1',
      sessionId: 'sess-1',
      traceId: 'tr-1',
      rating: 'up',
    });
    expect(r).toEqual({ ok: false, status: 500 });
  });
});
