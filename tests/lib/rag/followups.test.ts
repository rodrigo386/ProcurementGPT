import { describe, expect, it, beforeEach, vi } from 'vitest';

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
  vi.useRealTimers();
});

function mockGeminiOnce(returns: { text?: string; throws?: Error }) {
  const generateContent = vi.fn().mockImplementation(async () => {
    if (returns.throws) throw returns.throws;
    return { text: returns.text ?? '' };
  });
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({ models: { generateContent } }),
  }));
  return { generateContent };
}

const PT_CLASSIFICATION = {
  theory: 'kraljic',
  intent: 'definition' as const,
  language: 'pt' as const,
  needsRetrieval: true,
};

const SAMPLE_CHUNK = {
  chunkId: 'c1',
  articleId: 'a1',
  content: 'A matriz de Kraljic divide o portfolio em quatro quadrantes...',
  ord: 0,
  articleTitle: 'A Matriz de Kraljic',
  vectorRank: 1,
  ftsRank: 2,
  rrfScore: 0.5,
  rerankScore: 0.8,
};

describe('rag followups', () => {
  it('returns 3 deepen suggestions when chunks are present (PT)', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'Como aplicar Kraljic em PMEs?',
          'Diferenca entre Kraljic e Cox?',
          'Quais limitacoes da matriz?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que e a matriz de Kraljic?',
      answer: 'E um framework de Peter Kraljic publicado em 1983...',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([
      'Como aplicar Kraljic em PMEs?',
      'Diferenca entre Kraljic e Cox?',
      'Quais limitacoes da matriz?',
    ]);
    expect(generateContent).toHaveBeenCalledOnce();
    const callArg = generateContent.mock.calls[0]?.[0] as {
      contents: string;
      config: { responseMimeType: string };
    };
    expect(callArg.contents).toContain('Material disponivel');
    expect(callArg.contents).toContain('A Matriz de Kraljic');
    expect(callArg.config.responseMimeType).toBe('application/json');
  });

  it('returns 3 redirect suggestions when chunks is empty (PT)', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'Quer ver matriz de Kraljic?',
          'Modelos de TCO te interessam?',
          'Posso explicar SRM (Cousins)?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que e blockchain?',
      answer: 'Nao tenho fonte na base sobre isso.',
      chunks: [],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toHaveLength(3);
    const callArg = generateContent.mock.calls[0]?.[0] as { contents: string };
    expect(callArg.contents).toContain('reformulacoes');
    expect(callArg.contents).not.toContain('Material disponivel');
  });

  it('uses EN system prompt when classification.language is en', async () => {
    const { generateContent } = mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'How does Kraljic differ from Cox?',
          'How to apply it in food retail?',
          'What are the matrix limitations?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    await suggestFollowups({
      query: 'What is the Kraljic matrix?',
      answer: 'It is a framework by Peter Kraljic from 1983...',
      chunks: [SAMPLE_CHUNK],
      classification: { ...PT_CLASSIFICATION, language: 'en' },
      parentTrace: NOOP_TRACE,
    });
    const contents = (generateContent.mock.calls[0]?.[0] as { contents: string }).contents;
    expect(contents).toMatch(/follow-up/i);
    expect(contents).toContain('## Original question');
    expect(contents).not.toContain('Pergunta original');
  });

  it('returns [] when Gemini throws', async () => {
    mockGeminiOnce({ throws: new Error('boom') });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when JSON is malformed', async () => {
    mockGeminiOnce({ text: 'not json {' });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when schema rejects (item too long)', async () => {
    mockGeminiOnce({
      text: JSON.stringify({
        followups: ['ok', 'x'.repeat(200), 'fine'],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'q',
      answer: 'a',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual([]);
  });

  it('dedupes case-insensitively and removes echo of original query', async () => {
    mockGeminiOnce({
      text: JSON.stringify({
        followups: [
          'O que e a matriz de Kraljic?',
          'Como aplicar Kraljic em PMEs?',
          'COMO APLICAR KRALJIC EM PMES?',
        ],
      }),
    });
    const { suggestFollowups } = await import('@/lib/rag/followups');
    const out = await suggestFollowups({
      query: 'O que e a matriz de Kraljic?',
      answer: 'E um framework...',
      chunks: [SAMPLE_CHUNK],
      classification: PT_CLASSIFICATION,
      parentTrace: NOOP_TRACE,
    });
    expect(out).toEqual(['Como aplicar Kraljic em PMEs?']);
  });
});
