import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('lib/ingest/parser', () => {
  it('parsePdf returns text and page count via pdf-parse', async () => {
    const longText = 'Esta é uma frase longa o suficiente para passar do limite mínimo de 500 caracteres exigido pelo guardrail. '.repeat(10);
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({ text: longText, numpages: 7 }),
    }));
    const { parseFile } = await import('@/lib/ingest/parser');
    const out = await parseFile(Buffer.from([0x25, 0x50, 0x44, 0x46]), 'application/pdf', 'a.pdf');
    expect(out.text.length).toBeGreaterThan(500);
    expect(out.pageCount).toBe(7);
  });

  it('parseDocx returns text via mammoth', async () => {
    const longText = 'Conteúdo extraído do documento Word. '.repeat(40);
    vi.doMock('mammoth', () => ({
      extractRawText: vi.fn().mockResolvedValue({ value: longText }),
    }));
    const { parseFile } = await import('@/lib/ingest/parser');
    const out = await parseFile(
      Buffer.from('PK'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'a.docx',
    );
    expect(out.text).toContain('Conteúdo');
    expect(out.pageCount).toBeUndefined();
  });

  it('parseTxt reads UTF-8 directly from Buffer', async () => {
    const text = 'Texto cru de exemplo com acentuação portuguesa. '.repeat(20);
    const { parseFile } = await import('@/lib/ingest/parser');
    const out = await parseFile(Buffer.from(text, 'utf-8'), 'text/plain', 'a.txt');
    expect(out.text).toContain('acentuação');
  });

  it('throws when extracted text is shorter than 500 characters (OCR-required guard)', async () => {
    vi.doMock('pdf-parse', () => ({
      default: vi.fn().mockResolvedValue({ text: 'apenas duas linhas', numpages: 1 }),
    }));
    const { parseFile } = await import('@/lib/ingest/parser');
    await expect(
      parseFile(Buffer.from([0x25, 0x50, 0x44, 0x46]), 'application/pdf', 'scan.pdf'),
    ).rejects.toThrow(/OCR/i);
  });
});
