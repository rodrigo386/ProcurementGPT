import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function setupOpenAIMock(opts: { content?: string; throws?: Error; delayMs?: number } = {}) {
  const create = vi.fn().mockImplementation(async (_body, callOpts) => {
    if (opts.throws) throw opts.throws;
    if (opts.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        callOpts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    }
    return { choices: [{ message: { content: opts.content ?? '' } }] };
  });
  vi.doMock('@/lib/llm/openai', () => ({
    getOpenAI: () => ({ chat: { completions: { create } } }),
    getOpenAIModel: () => 'gpt-4o-mini',
    // Tests run in deterministic mode — pass through, no retry behavior.
    withRateLimitRetry: <T>(fn: () => Promise<T>) => fn(),
  }));
  return { create };
}

describe('classifyContent', () => {
  it('returns parsed { title, theme, summary } on valid JSON', async () => {
    setupOpenAIMock({
      content: JSON.stringify({
        title: 'Categorização de itens em compras estratégicas',
        theme: 'Kraljic',
        summary: 'Aplica a matriz a um varejo de alimentos',
      }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'kraljic.pdf');
    expect(out.title).toBe('Categorização de itens em compras estratégicas');
    expect(out.theme).toBe('Kraljic');
    expect(out.summary).toBe('Aplica a matriz a um varejo de alimentos');
  });

  it('strips wrapping quotes from title', async () => {
    setupOpenAIMock({
      content: JSON.stringify({
        title: '"Aplicação prática da matriz de Kraljic"',
        theme: 'Kraljic',
        summary: 's',
      }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.title).toBe('Aplicação prática da matriz de Kraljic');
  });

  it('falls back when theme is outside the taxonomy', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'Algum título OK aqui', theme: 'BogusTheme', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.theme).toBe('Outros');
    expect(out.title).toBe('k'); // filename stem fallback (no _- to replace)
  });

  it('falls back when title is too short', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'curto', theme: 'Kraljic', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'kraljic-2024.pdf');
    expect(out.title).toBe('kraljic 2024');
    expect(out.theme).toBe('Outros');
  });

  it('falls back when JSON is invalid', async () => {
    setupOpenAIMock({ content: 'not json at all' });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'foo_bar.pdf');
    expect(out.title).toBe('foo bar');
    expect(out.theme).toBe('Outros');
    expect(out.summary).toBe('');
  });

  it('falls back when OpenAI throws (network error)', async () => {
    setupOpenAIMock({ throws: new Error('ECONNRESET') });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'foo.pdf');
    expect(out.theme).toBe('Outros');
    expect(out.title).toBe('foo');
  });

  it('uses empty string when summary is missing', async () => {
    setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'TCO' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const out = await classifyContent('Texto longo. '.repeat(80), 'k.pdf');
    expect(out.summary).toBe('');
    expect(out.theme).toBe('TCO');
  });

  it('truncates input at ~6000 chars before sending', async () => {
    const m = setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'Outros', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    const huge = 'x'.repeat(50_000);
    await classifyContent(huge, 'big.pdf');
    const callBody = m.create.mock.calls[0]![0];
    const userMsg = callBody.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(userMsg.length).toBeLessThanOrEqual(6500); // some headroom for any prefix the impl adds
  });

  it('system prompt mentions at least 5 of the 11 themes', async () => {
    const m = setupOpenAIMock({
      content: JSON.stringify({ title: 'Título plausível com chars suficientes', theme: 'Outros', summary: '' }),
    });
    const { classifyContent } = await import('@/lib/ingest/classify-content');
    await classifyContent('texto', 'k.pdf');
    const callBody = m.create.mock.calls[0]![0];
    const sys = callBody.messages.find((m: { role: string }) => m.role === 'system').content as string;
    let found = 0;
    for (const t of ['Kraljic', 'Sourcing', 'SRM', 'TCO', 'Sustentabilidade', 'Risco', 'Negociação', 'Performance', 'Digital', 'Setor', 'Outros']) {
      if (sys.includes(t)) found++;
    }
    expect(found).toBeGreaterThanOrEqual(5);
  });

  it('aborts after the configured timeout (fail-soft to fallback)', async () => {
    vi.useFakeTimers();
    try {
      setupOpenAIMock({
        content: JSON.stringify({ title: 'Título OK aqui com chars', theme: 'Kraljic', summary: '' }),
        delayMs: 90_000,
      });
      const { classifyContent } = await import('@/lib/ingest/classify-content');
      const promise = classifyContent('texto', 'foo.pdf');
      // Timeout is 45s; advance well past it to trip the abort
      vi.advanceTimersByTime(60_000);
      const out = await promise;
      expect(out.theme).toBe('Outros');
      expect(out.title).toBe('foo');
    } finally {
      vi.useRealTimers();
    }
  });
});
