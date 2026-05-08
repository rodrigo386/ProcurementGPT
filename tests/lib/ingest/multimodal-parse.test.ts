import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  MULTIMODAL_SYSTEM_PROMPT,
  MULTIMODAL_RESPONSE_SCHEMA,
  validateBlocks,
} from '@/lib/ingest/multimodal-parse';

describe('multimodal-parse — prompt and schema', () => {
  it('system prompt instructs to skip headers/footers/page numbers', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/headers?\/footers?|cabe[çc]alhos|rodap[ée]s/i);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/p[áa]gina|page[- ]?number/i);
  });

  it('system prompt instructs to skip TOC', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/TOC|sum[áa]rio/i);
  });

  it('system prompt names all three figureKind values', () => {
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/flow/);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/chart/);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/diagram/);
  });

  it('system prompt explicitly forbids summarization (anti-Flash-Lite-summarize regression)', () => {
    // Without these, Gemini Flash Lite collapses long PDFs into 2-3 summary
    // blocks. See incident 2026-05-08 — 40-page ebook → 4.8k chars / 2 chunks.
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/N[ÃA]O\s+RESUMA/);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/transcreva|transcrever/i);
    expect(MULTIMODAL_SYSTEM_PROMPT).toMatch(/N[ÃA]O\s+(consolide|sintetize|comprima)/i);
  });

  it('response schema is an object with required blocks array', () => {
    expect(MULTIMODAL_RESPONSE_SCHEMA.type).toBe('object');
    expect(MULTIMODAL_RESPONSE_SCHEMA.required).toContain('blocks');
  });
});

describe('validateBlocks', () => {
  it('accepts well-formed mixed blocks', () => {
    const out = validateBlocks({
      blocks: [
        { type: 'text', page: 1, content: 'hello world' },
        { type: 'table', page: 2, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela 1' },
        {
          type: 'figure',
          page: 3,
          description: 'Description with twenty plus chars.',
          caption: 'Figura 1',
          figureKind: 'flow',
        },
      ],
    });
    expect(out).toHaveLength(3);
  });

  it('rejects empty blocks array', () => {
    expect(() => validateBlocks({ blocks: [] })).toThrow();
  });

  it('rejects unknown block type', () => {
    expect(() => validateBlocks({ blocks: [{ type: 'bogus', page: 1 }] })).toThrow();
  });

  it('defaults figureKind to "diagram" when Gemini omits it', () => {
    const out = validateBlocks({
      blocks: [{ type: 'figure', page: 1, description: 'a long enough description here' }],
    });
    expect(out).toHaveLength(1);
    const fig = out[0] as Extract<typeof out[number], { type: 'figure' }>;
    expect(fig.figureKind).toBe('diagram');
  });

  it('drops figure with no description AND no caption (no usable content)', () => {
    expect(() =>
      validateBlocks({
        blocks: [{ type: 'figure', page: 1, figureKind: 'flow' }],
      }),
    ).toThrow(/no usable blocks/);
  });

  it('uses caption as description when description is missing on figure', () => {
    const out = validateBlocks({
      blocks: [
        { type: 'figure', page: 2, caption: 'Figura 4: Fluxograma S2P', figureKind: 'flow' },
      ],
    });
    expect(out).toHaveLength(1);
    const fig = out[0] as Extract<typeof out[number], { type: 'figure' }>;
    expect(fig.description).toBe('Figura 4: Fluxograma S2P');
    expect(fig.caption).toBe('Figura 4: Fluxograma S2P');
  });

  it('drops empty-content text blocks while keeping good ones', () => {
    const out = validateBlocks({
      blocks: [
        { type: 'text', page: 1, content: '' },
        { type: 'text', page: 2, content: 'real content' },
      ],
    });
    expect(out).toHaveLength(1);
    expect((out[0] as Extract<typeof out[number], { type: 'text' }>).content).toBe('real content');
  });

  it('throws when ALL blocks are empty after repair', () => {
    expect(() =>
      validateBlocks({ blocks: [{ type: 'text', page: 1, content: '' }] }),
    ).toThrow(/no usable blocks/);
  });
});

beforeEach(() => {
  vi.resetModules();
});

function makeBuf(sizeBytes: number): Buffer {
  return Buffer.alloc(sizeBytes, 0x42);
}

function setupGeminiMock(responses: Array<{ text?: string; throws?: Error }>) {
  let call = 0;
  const generateContent = vi.fn().mockImplementation(async () => {
    const r = responses[call++];
    if (!r) throw new Error('mock exhausted');
    if (r.throws) throw r.throws;
    return { text: r.text ?? '' };
  });
  const filesUpload = vi.fn().mockResolvedValue({ name: 'files/abc-123' });
  vi.doMock('@/lib/llm/gemini', () => ({
    getGemini: () => ({
      models: { generateContent },
      files: { upload: filesUpload },
    }),
  }));
  vi.doMock('@/lib/env', () => ({
    requireEnv: vi.fn().mockReturnValue('gemini-3.1-flash-lite-preview'),
  }));
  return { generateContent, filesUpload };
}

describe('parsePdfMultimodal — happy and retry', () => {
  const validJson = JSON.stringify({
    blocks: [
      { type: 'text', page: 1, content: 'Hello text from PDF.' },
      { type: 'table', page: 2, markdown: '| a |\n|---|\n| 1 |', caption: 'Tabela X' },
      {
        type: 'figure',
        page: 3,
        description: 'A flow diagram with three nodes connected by arrows in sequence.',
        caption: 'Figura Y',
        figureKind: 'flow',
      },
    ],
  });

  it('returns blocks in order on first-call success (inline path, <20MB)', async () => {
    const m = setupGeminiMock([{ text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const out = await parsePdfMultimodal(makeBuf(1024));
    expect(out.blocks).toHaveLength(3);
    expect(out.blocks.map((b) => b.type)).toEqual(['text', 'table', 'figure']);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
    expect(m.filesUpload).not.toHaveBeenCalled();
    // Confirm inline base64 was passed
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const arg = m.generateContent.mock.calls[0]![0];
    const parts = (arg.contents as Array<{ inlineData?: unknown }>) ?? [];
    expect(parts.some((p) => 'inlineData' in p)).toBe(true);
  });

  it('retries once with retry suffix when first JSON fails zod', async () => {
    const m = setupGeminiMock([{ text: '{"blocks": []}' }, { text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const out = await parsePdfMultimodal(makeBuf(1024));
    expect(out.blocks).toHaveLength(3);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const secondCallContents = m.generateContent.mock.calls[1]![0].contents;
    // Concatenated as a string; just confirm the retry suffix landed in there
    const flat = JSON.stringify(secondCallContents);
    expect(flat).toMatch(/Sua resposta anterior n[ãa]o bateu com o schema/);
  });

  it('throws after second failure (zod fail twice)', async () => {
    setupGeminiMock([{ text: '{"blocks": []}' }, { text: '{"blocks": []}' }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow();
  });

  it('throws specific error when blocks: [] is returned', async () => {
    setupGeminiMock([{ text: '{"blocks": []}' }, { text: '{"blocks": []}' }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow();
  });

  it('rethrows network errors without retry', async () => {
    const m = setupGeminiMock([{ throws: new Error('ECONNRESET') }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    await expect(parsePdfMultimodal(makeBuf(1024))).rejects.toThrow(/ECONNRESET/);
    expect(m.generateContent).toHaveBeenCalledTimes(1);
  });
});

describe('parsePdfMultimodal — Files API (>20MB)', () => {
  const validJson = JSON.stringify({
    blocks: [{ type: 'text', page: 1, content: 'Big PDF text.' }],
  });

  it('uploads via Files API when buffer exceeds 20MB', async () => {
    const m = setupGeminiMock([{ text: validJson }]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    const out = await parsePdfMultimodal(big);
    expect(out.blocks).toHaveLength(1);
    expect(m.filesUpload).toHaveBeenCalledTimes(1);
    // Confirm fileData (not inlineData) was passed in the second call
    const arg = m.generateContent.mock.calls[0]![0];
    const parts = arg.contents as Array<Record<string, unknown>>;
    expect(parts.some((p) => 'fileData' in p)).toBe(true);
  });

  it('Files API path also retries once on zod fail', async () => {
    const m = setupGeminiMock([
      { text: '{"blocks": []}' },
      { text: validJson },
    ]);
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    const out = await parsePdfMultimodal(big);
    expect(out.blocks).toHaveLength(1);
    expect(m.generateContent).toHaveBeenCalledTimes(2);
    expect(m.filesUpload).toHaveBeenCalledTimes(1); // upload only once
  });

  it('Files API upload failure surfaces as throw (caller falls back)', async () => {
    const filesUpload = vi.fn().mockRejectedValue(new Error('files API quota'));
    const generateContent = vi.fn();
    vi.doMock('@/lib/llm/gemini', () => ({
      getGemini: () => ({ models: { generateContent }, files: { upload: filesUpload } }),
    }));
    vi.doMock('@/lib/env', () => ({
      requireEnv: vi.fn().mockReturnValue('gemini-3.1-flash-lite-preview'),
    }));
    const { parsePdfMultimodal } = await import('@/lib/ingest/multimodal-parse');
    const big = Buffer.alloc(21 * 1024 * 1024, 0x42);
    await expect(parsePdfMultimodal(big)).rejects.toThrow(/files API quota/);
    expect(generateContent).not.toHaveBeenCalled();
  });
});
