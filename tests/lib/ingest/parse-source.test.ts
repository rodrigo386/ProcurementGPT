import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

function setupParserMocks(opts: {
  multimodalThrows?: Error;
  multimodalBlocks?: unknown[];
  textOnlyText?: string;
  textOnlyThrows?: Error;
  docxBlocks?: unknown[];
  docxThrows?: Error;
}) {
  const multimodal = vi.fn().mockImplementation(async () => {
    if (opts.multimodalThrows) throw opts.multimodalThrows;
    return { blocks: opts.multimodalBlocks ?? [{ type: 'text', page: 1, content: 'mm' }] };
  });
  const textOnly = vi.fn().mockImplementation(async () => {
    if (opts.textOnlyThrows) throw opts.textOnlyThrows;
    return { text: opts.textOnlyText ?? 'fallback text long enough '.repeat(40), pageCount: 5 };
  });
  const docx = vi.fn().mockImplementation(async () => {
    if (opts.docxThrows) throw opts.docxThrows;
    return { blocks: opts.docxBlocks ?? [{ type: 'text', page: 1, content: 'd' }] };
  });
  vi.doMock('@/lib/ingest/multimodal-parse', () => ({ parsePdfMultimodal: multimodal }));
  vi.doMock('@/lib/ingest/parser', () => ({
    parsePdfTextOnly: textOnly,
    parseDocxTextOnly: vi.fn().mockResolvedValue({ text: 'docx fallback text long enough '.repeat(40) }),
    parseTxt: vi.fn().mockReturnValue({ text: 'txt content long enough '.repeat(40) }),
    parseFile: vi.fn(),
  }));
  vi.doMock('@/lib/ingest/docx-parse', () => ({ parseDocxWithTables: docx }));
  return { multimodal, textOnly, docx };
}

describe('parseSource', () => {
  it('PDF happy path: multimodal succeeds → returns blocks with parser=multimodal', async () => {
    const m = setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf');
    expect(out.parser).toBe('multimodal');
    expect(out.parsed.kind).toBe('blocks');
    expect(m.multimodal).toHaveBeenCalledTimes(1);
    expect(m.textOnly).not.toHaveBeenCalled();
  });

  it('PDF fallback: multimodal throws → text-only succeeds → parser=text-only-fallback', async () => {
    const m = setupParserMocks({ multimodalThrows: new Error('gemini boom') });
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf');
    expect(out.parser).toBe('text-only-fallback');
    expect(out.parsed.kind).toBe('text');
    expect(m.multimodal).toHaveBeenCalledTimes(1);
    expect(m.textOnly).toHaveBeenCalledTimes(1);
  });

  it('PDF double failure: both multimodal and text-only throw → propagates BOTH so the multimodal cause survives in error_message', async () => {
    setupParserMocks({
      multimodalThrows: new Error('openai boom'),
      textOnlyThrows: new Error('OCR necessário'),
    });
    const { parseSource } = await import('@/lib/ingest/parse-source');
    await expect(
      parseSource(Buffer.from('x'), 'application/pdf', 'a.pdf'),
    ).rejects.toThrow(/OCR.*Multimodal.*openai boom/);
  });

  it('DOCX path: calls parseDocxWithTables, parser=docx-tables', async () => {
    const m = setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(
      Buffer.from('x'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.docx',
    );
    expect(out.parser).toBe('docx-tables');
    expect(out.parsed.kind).toBe('blocks');
    expect(m.docx).toHaveBeenCalledTimes(1);
    expect(m.multimodal).not.toHaveBeenCalled();
  });

  it('TXT path: parser=text-only', async () => {
    setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    const out = await parseSource(Buffer.from('hello world'), 'text/plain', 'a.txt');
    expect(out.parser).toBe('text-only');
    expect(out.parsed.kind).toBe('text');
  });

  it('unsupported mime throws', async () => {
    setupParserMocks({});
    const { parseSource } = await import('@/lib/ingest/parse-source');
    await expect(
      parseSource(Buffer.from('x'), 'image/png', 'a.png'),
    ).rejects.toThrow(/n[ãa]o suportado|unsupported/i);
  });
});
