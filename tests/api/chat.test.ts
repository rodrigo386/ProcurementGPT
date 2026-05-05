import { describe, expect, it, beforeEach, vi } from 'vitest';

// Shared NOOP trace returned by all startTrace mocks
const NOOP_SPAN = { end: vi.fn() };
const NOOP_TRACE = {
  id: 'mock-trace-id',
  span: vi.fn(() => NOOP_SPAN),
  end: vi.fn(),
  setMetadata: vi.fn(),
  setTag: vi.fn(),
};

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'gemini-test';
  vi.resetModules();
});

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat', () => {
  it('returns 400 when messages is missing or empty', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const res1 = await POST(makeReq({}));
    expect(res1.status).toBe(400);
    const res2 = await POST(makeReq({ messages: [] }));
    expect(res2.status).toBe(400);
  });

  it('returns 400 when last message is not user', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(
      makeReq({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('orchestrates condenser, runRag, streamText with correct shapes', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-123' }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));

    const condenseSpy = vi.fn().mockResolvedValue('standalone-query');
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: condenseSpy }));

    const runRagSpy = vi.fn().mockResolvedValue({
      classification: { theory: 'kraljic', intent: 'definition', language: 'pt', needsRetrieval: true },
      chunks: [],
      sources: [{ number: 1, articleId: 'a', articleTitle: 'A Matriz de Kraljic', chunkId: 'c1' }],
      system: 'SYSTEM_PROMPT',
      user: 'USER_WITH_CONTEXT',
      debug: { classifyMs: 1, embedMs: 2, vectorMs: 3, ftsMs: 4, rerankMs: 5, totalMs: 15 },
    });
    vi.doMock('@/lib/rag', () => ({ runRag: runRagSpy }));

    const streamTextSpy = vi.fn().mockReturnValue({
      toDataStreamResponse: vi.fn(() => new Response('streamed-body', { status: 200 })),
    });
    const annotationSpy = vi.fn();
    const closeSpy = vi.fn();
    vi.doMock('ai', () => ({
      streamText: streamTextSpy,
      StreamData: class {
        appendMessageAnnotation = annotationSpy;
        close = closeSpy;
      },
    }));
    const modelFactory = vi.fn(() => 'mock-model');
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => modelFactory),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const messages = [
      { role: 'user', content: 'O que é Kraljic?' },
      { role: 'assistant', content: 'É um framework...' },
      { role: 'user', content: 'E como aplicar?' },
    ];
    const res = await POST(makeReq({ messages }));

    expect(res.status).toBe(200);
    expect(condenseSpy).toHaveBeenCalledWith(messages);
    // runRag now receives (standalone, { parentTrace }) — check first arg only
    expect(runRagSpy).toHaveBeenCalledWith('standalone-query', expect.objectContaining({ parentTrace: NOOP_TRACE }));

    const streamArgs = streamTextSpy.mock.calls[0]![0];
    expect(streamArgs.system).toBe('SYSTEM_PROMPT');
    expect(streamArgs.model).toBe('mock-model');
    // last message swapped to rag.user, history preserved
    const passedMessages = streamArgs.messages;
    expect(passedMessages).toHaveLength(3);
    expect(passedMessages[0]).toEqual({ role: 'user', content: 'O que é Kraljic?' });
    expect(passedMessages[1]).toEqual({ role: 'assistant', content: 'É um framework...' });
    expect(passedMessages[2]).toEqual({ role: 'user', content: 'USER_WITH_CONTEXT' });

    expect(annotationSpy).toHaveBeenCalledTimes(1);
    expect(annotationSpy).toHaveBeenCalledWith({
      sources: [{ number: 1, articleId: 'a', articleTitle: 'A Matriz de Kraljic', chunkId: 'c1' }],
      classification: { theory: 'kraljic', intent: 'definition', language: 'pt', needsRetrieval: true },
      debug: { classifyMs: 1, embedMs: 2, vectorMs: 3, ftsMs: 4, rerankMs: 5, totalMs: 15 },
      traceId: 'mock-trace-id',
    });
  });

  it('returns 500 when runRag throws', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockRejectedValue(new Error('boom')),
    }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(
      makeReq({ messages: [{ role: 'user', content: 'q' }] }),
    );
    expect(res.status).toBe(500);
  });

  it('returns 401 when there is no authenticated user', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue(null) }));
    vi.doMock('@/lib/rate-limit', () => ({ checkChatRateLimit: vi.fn() }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    expect(res.status).toBe(401);
  });

  it('returns 429 with Retry-After when rate limit is exceeded', async () => {
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn() }));
    vi.doMock('@/lib/rag', () => ({ runRag: vi.fn() }));
    vi.doMock('ai', () => ({
      streamText: vi.fn(),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/auth', () => ({
      getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: false, retryAfterSecs: 60 }),
    }));

    const { POST } = await import('@/app/api/chat/route');
    const res = await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await res.json();
    expect(body).toEqual({ error: 'rate_limited', retry_after_secs: 60 });
  });

  it('includes traceId in the message annotation', async () => {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1' }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    }));
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(NOOP_TRACE),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));

    const condenseSpy = vi.fn().mockResolvedValue('standalone-query');
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: condenseSpy }));

    const runRagSpy = vi.fn().mockResolvedValue({
      classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
      sources: [],
      system: 'sys',
      user: 'user q',
      debug: { classifyMs: 1, embedMs: 1, vectorMs: 1, ftsMs: 1, rerankMs: 1, totalMs: 5 },
    });
    vi.doMock('@/lib/rag', () => ({ runRag: runRagSpy }));

    const appendMessageAnnotation = vi.fn();
    vi.doMock('ai', () => ({
      streamText: vi.fn(() => ({
        toDataStreamResponse: () => new Response('ok', { status: 200 }),
      })),
      StreamData: class {
        appendMessageAnnotation = appendMessageAnnotation;
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/google', () => ({
      createGoogleGenerativeAI: vi.fn(() => () => 'mock-model'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));

    expect(appendMessageAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'mock-trace-id' }),
    );
  });
});
