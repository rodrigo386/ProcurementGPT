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

  it('refusal rule lives in the system prompt (always available) and a no-context marker lands in the user message when chunks are empty', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    // System always carries the rule, regardless of chunks
    expect(result.system.toLowerCase()).toMatch(/não\s+(tenho|tem)\s+fonte/);
    expect(result.system.toLowerCase()).toContain('não invente');
    // User message tells the model the lookup actually came back empty
    expect(result.user).toMatch(/nenhum trecho relevante|no relevant passage/i);
    expect(result.sources).toEqual([]);
    expect(result.user).toContain('?');
  });

  it('English classification puts the language directive in the USER message, not in the system prompt (system stays byte-stable)', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('What is Kraljic?', [], enClass);
    expect(result.user).toMatch(/respond in english/i);
    // Critical: language directive is NOT in system. System must stay
    // identical regardless of language so OpenAI's prefix cache still hits.
    expect(result.system).not.toMatch(/respond in english/i);
  });

  it('default Portuguese: no English directive injected anywhere', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('?', [], ptClass);
    expect(result.user).not.toMatch(/respond in english/i);
    expect(result.system).not.toMatch(/respond in english/i);
  });

  it('includes the persona and response-structure framing in system prompt', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const result = buildPrompt('q', [chunk('a', 'A', 'T')], ptClass);
    expect(result.system).toMatch(/especialista/i);
    expect(result.system).toMatch(/procurement/i);
    expect(result.system).toMatch(/resposta direta/i);
    expect(result.system).toMatch(/aplicação prática/i);
  });

  it('system prompt is byte-identical across PT/EN classifications and across empty/non-empty chunks (the cache-stability invariant)', async () => {
    const { buildPrompt } = await import('@/lib/rag/prompt-builder');
    const a = buildPrompt('q1', [], ptClass);
    const b = buildPrompt('q2', [chunk('c', 'x', 'T')], ptClass);
    const c = buildPrompt('q3', [], enClass);
    const d = buildPrompt('q4', [chunk('c', 'x', 'T')], enClass);
    expect(a.system).toBe(b.system);
    expect(a.system).toBe(c.system);
    expect(a.system).toBe(d.system);
  });

  it('system prompt is large enough to clear OpenAI’s 1024-token prefix-cache threshold (chars/4 is a conservative proxy)', async () => {
    const { SYSTEM_PROMPT } = await import('@/lib/rag/prompt-builder');
    const approxTokens = Math.round(SYSTEM_PROMPT.length / 4);
    expect(approxTokens).toBeGreaterThanOrEqual(1024);
  });

  it('system prompt names the procurement framework anchors so the model can lean on them deliberately', async () => {
    const { SYSTEM_PROMPT } = await import('@/lib/rag/prompt-builder');
    // Smoke test that the framework reference block survived future edits
    expect(SYSTEM_PROMPT).toMatch(/Kraljic/);
    expect(SYSTEM_PROMPT).toMatch(/Porter/);
    expect(SYSTEM_PROMPT).toMatch(/Monczka/);
    expect(SYSTEM_PROMPT).toMatch(/TCO/);
    expect(SYSTEM_PROMPT).toMatch(/S2P|Source-to-Pay/i);
  });
});
