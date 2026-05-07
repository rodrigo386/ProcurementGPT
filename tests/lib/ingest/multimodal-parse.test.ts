import { describe, expect, it } from 'vitest';
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

  it('rejects figure without figureKind', () => {
    expect(() =>
      validateBlocks({
        blocks: [{ type: 'figure', page: 1, description: 'a long enough description here' }],
      }),
    ).toThrow();
  });

  it('rejects text with empty content', () => {
    expect(() =>
      validateBlocks({ blocks: [{ type: 'text', page: 1, content: '' }] }),
    ).toThrow();
  });
});
