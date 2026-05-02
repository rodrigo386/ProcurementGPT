import { describe, expect, it } from 'vitest';
import type { Classification, RetrievedChunk } from '@/lib/rag/types';

function chunk(id: string, content: string, title: string): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    content,
    ord: 0,
    articleTitle: title,
    vectorRank: null,
    ftsRank: null,
    rrfScore: 0,
    rerankScore: null,
  };
}

const ptClass: Classification = {
  theory: null,
  intent: 'definition',
  language: 'pt',
  needsRetrieval: true,
};
const enClass: Classification = { ...ptClass, language: 'en' };

describe('rag prompt-builder', () => {
  it('still returns sources array with numbers (kept for admin/debug channel)', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt(
      'q',
      [chunk('c1', 'a', 'TitleA'), chunk('c2', 'b', 'TitleB')],
      ptClass,
    );
    expect(result.sources.map((s) => s.number)).toEqual([1, 2]);
    expect(result.sources[0]?.articleTitle).toBe('TitleA');
  });

  it('does NOT emit [N] tokens in the user prompt context block', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt(
      'q',
      [chunk('c1', 'content one', 'TitleA'), chunk('c2', 'content two', 'TitleB')],
      ptClass,
    );
    // Headings show only the title — no [1], [2] tokens
    expect(result.user).toContain('TitleA');
    expect(result.user).toContain('content one');
    expect(result.user).not.toMatch(/\[\d+\]/);
  });

  it('system prompt instructs the model NOT to cite sources or numbers', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('q', [chunk('a', 'x', 'T')], ptClass);
    expect(result.system.toLowerCase()).toContain('não mencione');
    expect(result.system).toMatch(/\[\d+\]|colchetes/i);
    // It should mention NOT to use brackets — confirm the prohibitive framing
    const lower = result.system.toLowerCase();
    expect(lower).toMatch(/não.*colchetes|sem.*colchetes/);
  });

  it('includes refusal instruction when chunks are empty', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
    expect(result.system.toLowerCase()).toContain('não invente');
    expect(result.sources).toEqual([]);
    expect(result.user).toContain('?');
  });

  it('flips language hint to English when classification.language=en', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('What is Kraljic?', [], enClass);
    expect(result.system).toMatch(/respond in english/i);
    expect(result.system).not.toMatch(/responda em português/i);
  });

  it('uses Portuguese hint by default', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    expect(result.system).toMatch(/responda em português/i);
  });

  it('includes the persona and 4-part response structure in system prompt', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('q', [chunk('a', 'A', 'T')], ptClass);
    expect(result.system).toMatch(/especialista/i);
    expect(result.system).toMatch(/procurement/i);
    expect(result.system).toMatch(/resposta direta/i);
    expect(result.system).toMatch(/aplicação prática/i);
  });
});
