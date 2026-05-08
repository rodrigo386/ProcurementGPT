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
  process.env.OPENAI_API_KEY = 'test-key';
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => modelFactory),
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
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
      chunks: [],
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
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'mock-model'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));

    expect(appendMessageAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ traceId: 'mock-trace-id' }),
    );
  });
});

describe('POST /api/chat — followups annotation', () => {
  type OnFinishArg = {
    text: string;
    usage: { promptTokens: number; completionTokens: number };
    finishReason: string;
    providerMetadata?: { openai?: { cachedPromptTokens?: number } };
  };

  type SpanCaptured = { name: string; output: Record<string, unknown> };

  function setupCommonMocks(opts: {
    chunks: unknown[];
    suggestSpy?: ReturnType<typeof vi.fn>;
    traceTags?: string[];
    spans?: SpanCaptured[];
  }) {
    vi.doMock('@/lib/auth', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'u' }) }));
    vi.doMock('@/lib/rate-limit', () => ({
      checkChatRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    }));
    const trace = {
      id: 't',
      span: vi.fn((name: string) => ({
        end: vi.fn((output?: unknown) => {
          opts.spans?.push({ name, output: (output ?? {}) as Record<string, unknown> });
        }),
      })),
      end: vi.fn(),
      setMetadata: vi.fn(),
      setTag: vi.fn((t: string) => opts.traceTags?.push(t)),
    };
    vi.doMock('@/lib/observability/langfuse', () => ({
      startTrace: vi.fn().mockResolvedValue(trace),
      flushAsync: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('@/lib/rag/condenser', () => ({ condenseQuery: vi.fn().mockResolvedValue('q') }));
    vi.doMock('@/lib/rag', () => ({
      runRag: vi.fn().mockResolvedValue({
        classification: { theory: null, intent: 'definition', language: 'pt', needsRetrieval: true },
        chunks: opts.chunks,
        sources: [],
        system: '',
        user: '',
        debug: { classifyMs: 0, embedMs: 0, vectorMs: 0, ftsMs: 0, rerankMs: 0, totalMs: 0 },
      }),
    }));
    if (opts.suggestSpy) {
      vi.doMock('@/lib/rag/followups', () => ({ suggestFollowups: opts.suggestSpy }));
    }
    return trace;
  }

  it('appends followups annotation in onFinish (deepen path)', async () => {
    const traceTags: string[] = [];
    const suggestSpy = vi.fn().mockResolvedValue(['Q1?', 'Q2?', 'Q3?']);
    setupCommonMocks({
      chunks: [
        {
          chunkId: 'c1',
          articleId: 'a1',
          content: 'conteudo',
          ord: 0,
          articleTitle: 'T',
          vectorRank: 1,
          ftsRank: 1,
          rrfScore: 0.5,
          rerankScore: 0.8,
        },
      ],
      suggestSpy,
      traceTags,
    });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    const annotationSpy = vi.fn();
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = annotationSpy;
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({
      createOpenAI: vi.fn(() => () => 'm'),
    }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'uma resposta longa o suficiente',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });

    expect(suggestSpy).toHaveBeenCalledOnce();
    const followupsCall = annotationSpy.mock.calls.find((c) => 'followups' in (c[0] as object));
    expect(followupsCall?.[0]).toEqual({ followups: ['Q1?', 'Q2?', 'Q3?'] });
    expect(traceTags).not.toContain('followups:empty');
  });

  it('appends empty array and tags followups:empty when suggestFollowups returns []', async () => {
    const traceTags: string[] = [];
    setupCommonMocks({
      chunks: [],
      suggestSpy: vi.fn().mockResolvedValue([]),
      traceTags,
    });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    const annotationSpy = vi.fn();
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = annotationSpy;
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'uma resposta longa o suficiente',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });

    const fc = annotationSpy.mock.calls.find((c) => 'followups' in (c[0] as object));
    expect(fc?.[0]).toEqual({ followups: [] });
    expect(traceTags).toContain('followups:empty');
  });

  it('skips suggestFollowups when finishReason is not stop', async () => {
    const suggestSpy = vi.fn();
    setupCommonMocks({ chunks: [], suggestSpy });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'qualquer resposta longa',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'error',
    });

    expect(suggestSpy).not.toHaveBeenCalled();
  });

  it('skips suggestFollowups when text is shorter than 20 chars', async () => {
    const suggestSpy = vi.fn();
    setupCommonMocks({ chunks: [], suggestSpy });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'oi',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });

    expect(suggestSpy).not.toHaveBeenCalled();
  });

  it('logs cachedPromptTokens + cached_pct on generate span and tags trace cache:hit when OpenAI reports a cache hit', async () => {
    const traceTags: string[] = [];
    const spans: SpanCaptured[] = [];
    setupCommonMocks({
      chunks: [],
      suggestSpy: vi.fn().mockResolvedValue([]),
      traceTags,
      spans,
    });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'resposta longa o suficiente para ser processada',
      usage: { promptTokens: 1000, completionTokens: 200 },
      finishReason: 'stop',
      providerMetadata: { openai: { cachedPromptTokens: 400 } },
    });

    expect(traceTags).toContain('cache:hit');
    expect(traceTags).not.toContain('cache:miss');
    const generate = spans.find((s) => s.name === 'generate');
    expect(generate?.output.tokens_cached).toBe(400);
    expect(generate?.output.cached_pct).toBe(40);
    expect(generate?.output.tokens_in).toBe(1000);
  });

  it('tags trace cache:miss and records tokens_cached=0 when providerMetadata is absent (cold prompt)', async () => {
    const traceTags: string[] = [];
    const spans: SpanCaptured[] = [];
    setupCommonMocks({
      chunks: [],
      suggestSpy: vi.fn().mockResolvedValue([]),
      traceTags,
      spans,
    });

    const onFinishCapture: { fn?: (a: OnFinishArg) => Promise<void> } = {};
    vi.doMock('ai', () => ({
      streamText: vi.fn((cfg: { onFinish?: (a: OnFinishArg) => Promise<void> }) => {
        onFinishCapture.fn = cfg.onFinish;
        return { toDataStreamResponse: vi.fn(() => new Response('ok', { status: 200 })) };
      }),
      StreamData: class {
        appendMessageAnnotation = vi.fn();
        close = vi.fn();
      },
    }));
    vi.doMock('@ai-sdk/openai', () => ({ createOpenAI: vi.fn(() => () => 'm') }));

    const { POST } = await import('@/app/api/chat/route');
    await POST(makeReq({ messages: [{ role: 'user', content: 'oi' }] }));
    await onFinishCapture.fn!({
      text: 'resposta longa o suficiente para ser processada',
      usage: { promptTokens: 800, completionTokens: 100 },
      finishReason: 'stop',
      // No providerMetadata — simulates a cold prompt under the 1024 token threshold
    });

    expect(traceTags).toContain('cache:miss');
    expect(traceTags).not.toContain('cache:hit');
    const generate = spans.find((s) => s.name === 'generate');
    expect(generate?.output.tokens_cached).toBe(0);
    expect(generate?.output.cached_pct).toBe(0);
  });
});
