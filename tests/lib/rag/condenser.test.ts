import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ChatMessage } from '@/lib/rag/types';

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

describe('rag condenser', () => {
  it('returns content directly without calling Gemini for single-turn', async () => {
    const geminiSpy = vi.fn();
    vi.doMock('@/lib/llm/gemini', () => ({
      getGemini: () => ({
        models: { generateContent: geminiSpy },
      }),
    }));
    const { condenseQuery } = await import('@/lib/rag/condenser');
    const messages: ChatMessage[] = [{ role: 'user', content: '  hello world  ' }];
    const result = await condenseQuery(messages);
    expect(result).toBe('hello world');
    expect(geminiSpy).not.toHaveBeenCalled();
  });

  it('calls Gemini and returns rewritten string for multi-turn', async () => {
    mockGemini({ text: 'Como aplicar a matriz de Kraljic?' });
    const { condenseQuery } = await import('@/lib/rag/condenser');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'O que é a matriz de Kraljic?' },
      { role: 'assistant', content: 'É um framework de procurement...' },
      { role: 'user', content: 'E como aplicar?' },
    ];
    const result = await condenseQuery(messages);
    expect(result).toBe('Como aplicar a matriz de Kraljic?');
  });

  it('falls back to last user message when Gemini throws', async () => {
    mockGemini({ throws: new Error('boom') });
    const { condenseQuery } = await import('@/lib/rag/condenser');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'follow-up' },
    ];
    const result = await condenseQuery(messages);
    expect(result).toBe('follow-up');
  });

  it('falls back to last user message when Gemini returns empty text', async () => {
    mockGemini({ text: '' });
    const { condenseQuery } = await import('@/lib/rag/condenser');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const result = await condenseQuery(messages);
    expect(result).toBe('c');
  });

  it('strips wrapping quotes from the rewritten output', async () => {
    mockGemini({ text: '"o que é kraljic?"' });
    const { condenseQuery } = await import('@/lib/rag/condenser');
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const result = await condenseQuery(messages);
    expect(result).toBe('o que é kraljic?');
  });
});
