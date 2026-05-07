import { describe, expect, it, vi } from 'vitest';
import type { Block } from '@/lib/ingest/types';
import * as mammoth from 'mammoth';

vi.mock('mammoth', () => ({
  convertToHtml: vi.fn(),
  extractRawText: vi.fn(),
}));

function setupMammothMock(html: string, rawText?: string) {
  const defaultRawText = html.replace(/<[^>]+>/g, ' ').replace(/&[^;]+;/g, ' ');
  (mammoth.convertToHtml as any).mockResolvedValue({ value: html });
  (mammoth.extractRawText as any).mockResolvedValue({ value: rawText ?? defaultRawText });
}

describe('parseDocxWithTables', () => {
  it('emits a single text block when there are no tables', async () => {
    // Use different paragraphs to avoid cleanExtractedText's repetition filter (>=5 same lines = noise)
    const para1 = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>';
    const para2 = '<p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>';
    const para3 = '<p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>';
    setupMammothMock(para1 + para2 + para3 + para1 + para2);
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks).toHaveLength(1);
    expect(blocks.length > 0).toBe(true);
    expect(blocks[0]!.type).toBe('text');
    expect((blocks[0] as Extract<Block, { type: 'text' }>).content).toMatch(/Lorem ipsum/);
  });

  it('produces text + table + text blocks in order when one table sits in the middle', async () => {
    const para1 = '<p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>';
    const para2 = '<p>Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.</p>';
    setupMammothMock(
      para1 + para2 + para1 +
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>' +
      para1 + para2 + para1,
    );
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks.map((b) => b.type)).toEqual(['text', 'table', 'text']);
    const tbl = blocks[1] as Extract<Block, { type: 'table' }>;
    expect(tbl.markdown).toContain('| A | B |');
    expect(tbl.markdown).toContain('| 1 | 2 |');
  });

  it('emits two table blocks when there are two tables', async () => {
    const para1 = '<p>Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis.</p>';
    const para2 = '<p>Et quasi architecto beatae vitae dicta sunt explicabo nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit sed quia consequuntur magni dolores.</p>';
    setupMammothMock(
      para1 + para2 + para1 +
      '<table><tr><td>x</td></tr></table>' +
      para1 + para2 +
      '<table><tr><td>y</td></tr></table>' +
      para1 + para2,
    );
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks.filter((b) => b.type === 'table')).toHaveLength(2);
  });

  it('all blocks have page=1 (DOCX has no page concept in mammoth output)', async () => {
    const para1 = '<p>Et quasi architecto beatae vitae dicta sunt explicabo nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores.</p>';
    const para2 = '<p>Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet consectetur adipisci velit, sed quia non numquam eius modi tempora incidunt ut labore et dolore magnam aliquam quaerat voluptatem.</p>';
    setupMammothMock(
      para1 + para2 + para1 + para2 +
      '<table><tr><td>c</td></tr></table>' +
      para1 + para2 + para1,
    );
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    for (const b of blocks) expect(b.page).toBe(1);
  });

  it('throws clear error on empty DOCX', async () => {
    setupMammothMock('   ', '   ');
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    await expect(parseDocxWithTables(Buffer.from('x'))).rejects.toThrow(/conteúdo|vazio|curto/i);
  });

  it('falls back to extractRawText when convertToHtml throws (returns 1 text block)', async () => {
    (mammoth.convertToHtml as any).mockRejectedValue(new Error('html convert failed'));
    (mammoth.extractRawText as any).mockResolvedValue({ value: 'Plain text fallback content with enough characters to pass the guard. '.repeat(20) });
    const { parseDocxWithTables } = await import('@/lib/ingest/docx-parse');
    const { blocks } = await parseDocxWithTables(Buffer.from('x'));
    expect(blocks).toHaveLength(1);
    expect(blocks.length > 0).toBe(true);
    expect(blocks[0]!.type).toBe('text');
  });
});
