import { describe, expect, it, beforeEach, vi } from 'vitest';

beforeEach(() => {
  process.env.GOOGLE_API_KEY = 'test-key';
  process.env.GEMINI_MODEL = 'gemini-test';
  vi.resetModules();
});

function mockGemini(returns: { text?: string; throws?: Error }) {
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({
      models: {
        generateContent: vi.fn().mockImplementation(async () => {
          if (returns.throws) throw returns.throws;
          return { text: returns.text ?? '' };
        }),
      },
    }),
  }));
}

describe('rag classifier', () => {
  it('returns parsed classification on valid JSON', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: 'kraljic',
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('o que é a matriz de Kraljic?');
    expect(result).toEqual({
      theory: 'kraljic',
      intent: 'definition',
      language: 'pt',
      needsRetrieval: true,
    });
  });

  it('returns safe default when Gemini throws', async () => {
    mockGemini({ throws: new Error('boom') });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('hello');
    expect(result).toEqual({
      theory: null,
      intent: 'definition',
      language: 'pt',
      needsRetrieval: true,
    });
  });

  it('returns safe default when JSON is malformed', async () => {
    mockGemini({ text: 'not json {' });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('hi');
    expect(result.intent).toBe('definition');
    expect(result.needsRetrieval).toBe(true);
    expect(result.theory).toBeNull();
  });

  it('returns safe default when intent enum is invalid', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'bogus',
        language: 'pt',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('?');
    expect(result.intent).toBe('definition');
  });

  it('accepts smalltalk intent and propagates needsRetrieval=false', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'smalltalk',
        language: 'pt',
        needsRetrieval: false,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('oi');
    expect(result.intent).toBe('smalltalk');
    expect(result.needsRetrieval).toBe(false);
  });

  it('accepts theory as null and intent as application', async () => {
    mockGemini({
      text: JSON.stringify({
        theory: null,
        intent: 'application',
        language: 'en',
        needsRetrieval: true,
      }),
    });
    const { classify } = await import('@/lib/rag/classifier');
    const result = await classify('how to apply Kraljic in food retail?');
    expect(result.intent).toBe('application');
    expect(result.language).toBe('en');
  });
});
