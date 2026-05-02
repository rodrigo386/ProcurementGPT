import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-key';
  process.env.VOYAGE_MODEL = 'voyage-3-large';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  vi.resetModules();
});

type RpcResult = { data: unknown; error: null | { message: string } };

function mockSupabase(handlers: {
  matchChunks?: () => Promise<RpcResult>;
  searchChunksFts?: () => Promise<RpcResult>;
  articlesIn?: (ids: string[]) => Promise<RpcResult>;
}) {
  vi.doMock('@/lib/db/supabase', () => ({
    getServerSupabase: () => ({
      rpc: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'match_chunks') {
          return handlers.matchChunks ? handlers.matchChunks() : { data: [], error: null };
        }
        if (name === 'search_chunks_fts') {
          return handlers.searchChunksFts
            ? handlers.searchChunksFts()
            : { data: [], error: null };
        }
        return { data: [], error: null };
      }),
      from: vi.fn().mockImplementation(() => ({
        select: () => ({
          in: (_col: string, ids: string[]) =>
            handlers.articlesIn
              ? handlers.articlesIn(ids)
              : Promise.resolve({ data: [], error: null }),
        }),
      })),
    }),
  }));
}

function mockEmbed() {
  vi.doMock('@/lib/llm/voyage', () => ({
    embed: vi.fn().mockResolvedValue([new Array(1024).fill(0.01)]),
  }));
}

describe('rag retriever', () => {
  it('returns empty when both vector and FTS are empty', async () => {
    mockEmbed();
    mockSupabase({});
    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('anything');
    expect(result).toEqual([]);
  });

  it('orders chunks by RRF score across both lists with dedup', async () => {
    mockEmbed();
    mockSupabase({
      matchChunks: async () => ({
        data: [
          { chunk_id: 'A', article_id: 'art1', content: 'a', ord: 0, similarity: 0.9 },
          { chunk_id: 'B', article_id: 'art1', content: 'b', ord: 1, similarity: 0.8 },
          { chunk_id: 'C', article_id: 'art2', content: 'c', ord: 0, similarity: 0.7 },
        ],
        error: null,
      }),
      searchChunksFts: async () => ({
        data: [
          { chunk_id: 'C', article_id: 'art2', content: 'c', ord: 0, rank: 0.5 },
          { chunk_id: 'A', article_id: 'art1', content: 'a', ord: 0, rank: 0.4 },
          { chunk_id: 'D', article_id: 'art3', content: 'd', ord: 0, rank: 0.3 },
        ],
        error: null,
      }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: `Title-${id}` })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q', { rrfK: 60 });

    // Each unique chunkId appears once
    const ids = result.map((r) => r.chunkId);
    expect(new Set(ids).size).toBe(ids.length);

    // A and C appear in both → highest scores. A ranks #1 in vector + #2 in fts. C ranks #3 in vector + #1 in fts.
    // RRF(A) = 1/61 + 1/62 ; RRF(C) = 1/63 + 1/61. A > C.
    expect(result[0]?.chunkId).toBe('A');
    expect(result[1]?.chunkId).toBe('C');
    // B (vector only, rank 2) vs D (fts only, rank 3): B should outrank D.
    const bIdx = ids.indexOf('B');
    const dIdx = ids.indexOf('D');
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeGreaterThan(bIdx);

    // Joins article titles
    expect(result[0]?.articleTitle).toBe('Title-art1');
  });

  it('preserves vector order when FTS is empty', async () => {
    mockEmbed();
    mockSupabase({
      matchChunks: async () => ({
        data: [
          { chunk_id: 'X', article_id: 'a', content: 'x', ord: 0, similarity: 0.9 },
          { chunk_id: 'Y', article_id: 'a', content: 'y', ord: 1, similarity: 0.8 },
        ],
        error: null,
      }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: 't' })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q');
    expect(result.map((r) => r.chunkId)).toEqual(['X', 'Y']);
    expect(result[0]?.vectorRank).toBe(1);
    expect(result[0]?.ftsRank).toBeNull();
  });

  it('truncates result to outK', async () => {
    mockEmbed();
    const many = Array.from({ length: 50 }, (_, i) => ({
      chunk_id: `c${i}`,
      article_id: 'a',
      content: 'x',
      ord: i,
      similarity: 1 - i * 0.01,
    }));
    mockSupabase({
      matchChunks: async () => ({ data: many, error: null }),
      articlesIn: async (ids) => ({
        data: ids.map((id) => ({ id, title: 't' })),
        error: null,
      }),
    });

    const { retrieve } = await import('@/lib/rag/retriever');
    const result = await retrieve('q', { outK: 5 });
    expect(result).toHaveLength(5);
  });
});
