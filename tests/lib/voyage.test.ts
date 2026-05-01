import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.VOYAGE_API_KEY = 'test-key';
  process.env.VOYAGE_MODEL = 'voyage-3-large';
  vi.resetModules();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('voyage embed', () => {
  it('posts to /v1/embeddings with auth and model and returns embeddings array', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('@/lib/llm/voyage');
    const result = await embed(['hello', 'world']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ model: 'voyage-3-large', input: ['hello', 'world'] });
  });

  it('throws when API returns non-200', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('rate limit', { status: 429 }),
    ) as typeof fetch;

    const { embed } = await import('@/lib/llm/voyage');
    await expect(embed(['x'])).rejects.toThrow(/voyage/i);
  });

  it('returns empty array without calling fetch when input is empty', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;

    const { embed } = await import('@/lib/llm/voyage');
    const result = await embed([]);

    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
