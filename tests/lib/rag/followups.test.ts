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
});
