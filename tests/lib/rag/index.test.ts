import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { RetrievedChunk } from '@/lib/rag/types';

beforeEach(() => {
  vi.resetModules();
});

function chunk(id: string): RetrievedChunk {
  return {
    chunkId: id,
    articleId: `art-${id}`,
    content: `content ${id}`,
    ord: 0,
    articleTitle: `Title ${id}`,
    vectorRank: 1,
    ftsRank: null,
    rrfScore: 0.5,
    rerankScore: null,
  };
}

describe('rag runRag', () => {
  it('runs the full pipeline and returns sources + system + user + debug', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: 'kraljic',
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    }));
    const retrieved = [chunk('a'), chunk('b')];
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue(retrieved),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([
        { ...retrieved[0]!, rerankScore: 0.9 },
      ]),
    }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('o que é kraljic?');

    expect(result.classification.theory).toBe('kraljic');
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.chunkId).toBe('a');
    expect(result.user).not.toMatch(/\[\d+\]/);
    expect(result.system).toMatch(/especialista/i);
    expect(result.debug.totalMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.debug.classifyMs).toBe('number');
  });

  it('short-circuits retrieve and rerank when needsRetrieval is false', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: null,
        intent: 'smalltalk',
        language: 'pt',
        needsRetrieval: false,
      }),
    }));
    const retrieveSpy = vi.fn();
    const rerankSpy = vi.fn();
    vi.doMock('@/lib/rag/retriever', () => ({ retrieve: retrieveSpy }));
    vi.doMock('@/lib/rag/reranker', () => ({ rerank: rerankSpy }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('oi');

    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(rerankSpy).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
  });

  it('handles empty retrieved chunks by going through buildPrompt empty branch', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: null,
        intent: 'definition',
        language: 'pt',
        needsRetrieval: true,
      }),
    }));
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([]),
    }));

    const { runRag } = await import('@/lib/rag');
    const result = await runRag('pergunta sem fonte');
    expect(result.sources).toEqual([]);
    expect(result.system.toLowerCase()).toContain('não tem fonte');
  });

  it('opens spans on a provided parentTrace for classify, retrieve, rerank, build-prompt', async () => {
    vi.doMock('@/lib/rag/classifier', () => ({
      classify: vi.fn().mockResolvedValue({
        theory: 'kraljic', intent: 'definition', language: 'pt', needsRetrieval: true,
      }),
    }));
    const retrieved = [chunk('a'), chunk('b')];
    vi.doMock('@/lib/rag/retriever', () => ({
      retrieve: vi.fn().mockResolvedValue(retrieved),
    }));
    vi.doMock('@/lib/rag/reranker', () => ({
      rerank: vi.fn().mockResolvedValue([{ ...retrieved[0]!, rerankScore: 0.9 }]),
    }));

    const spans: Array<{ name: string; ended: boolean }> = [];
    const trace = {
      id: 'mock-trace-id',
      span: (name: string) => {
        const entry = { name, ended: false };
        spans.push(entry);
        return { end: () => { entry.ended = true; } };
      },
      end: () => {},
      setMetadata: () => {},
      setTag: () => {},
    };

    const { runRag } = await import('@/lib/rag');
    await runRag('o que é Kraljic?', { parentTrace: trace });
    const names = spans.map((s) => s.name);
    expect(names).toEqual(['classify', 'retrieve', 'rerank', 'build-prompt']);
    expect(spans.every((s) => s.ended)).toBe(true);
  });
});
