import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/supabase', () => ({
  getServerSupabase: vi.fn(),
}));
vi.mock('@/lib/llm/voyage', () => ({ embed: vi.fn() }));
vi.mock('@/lib/llm/cohere', () => ({ rerank: vi.fn() }));
vi.mock('@/lib/llm/openai', () => ({ pingOpenAI: vi.fn() }));

import { getServerSupabase } from '@/lib/db/supabase';
import { embed } from '@/lib/llm/voyage';
import { rerank } from '@/lib/llm/cohere';
import { pingOpenAI } from '@/lib/llm/openai';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.mocked(getServerSupabase).mockReturnValue({
      from: () => ({
        select: () => ({ limit: () => Promise.resolve({ data: [], error: null }) }),
      }),
    } as never);
    vi.mocked(embed).mockResolvedValue([[0.1]]);
    vi.mocked(rerank).mockResolvedValue([{ index: 0, relevanceScore: 1 }]);
    vi.mocked(pingOpenAI).mockResolvedValue('pong');
  });

  it('returns 200 with all checks ok when every dependency succeeds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({
      supabase: 'ok',
      voyage: 'ok',
      cohere: 'ok',
      openai: 'ok',
    });
    expect(typeof body.ms).toBe('number');
  });

  it('returns 503 with error details when one dependency fails', async () => {
    vi.mocked(embed).mockRejectedValue(new Error('voyage down'));
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.checks.voyage).toMatch(/error.*voyage down/i);
    expect(body.checks.supabase).toBe('ok');
  });

  it('captures supabase errors from the response shape', async () => {
    vi.mocked(getServerSupabase).mockReturnValue({
      from: () => ({
        select: () => ({
          limit: () =>
            Promise.resolve({ data: null, error: { message: 'connection refused' } }),
        }),
      }),
    } as never);
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.supabase).toMatch(/connection refused/);
  });
});
