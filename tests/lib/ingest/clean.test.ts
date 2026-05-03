import { describe, expect, it } from 'vitest';

describe('lib/ingest/clean', () => {
  it('removes lines that repeat 5+ times (page headers/footers)', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    // Repeated header line interleaved with real content.
    const repeated = '036.310.189-67 Celso Rudey';
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      lines.push(repeated);
      lines.push(`Conteúdo da página ${i + 1} com texto real.`);
    }
    const out = cleanExtractedText(lines.join('\n'));
    expect(out.includes(repeated)).toBe(false);
    expect(out).toContain('Conteúdo da página 1');
    expect(out).toContain('Conteúdo da página 6');
  });

  it('keeps lines that repeat fewer than 5 times', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = 'Procurement\n\nProcurement\n\nProcurement';
    const out = cleanExtractedText(text);
    // 3 occurrences → all kept
    expect(out.match(/Procurement/g)?.length).toBe(3);
  });

  it('removes TOC dot-leader lines (text ........ N)', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = [
      'INTRODUÇÃO .................................................................................................................... 6',
      '1. SUSTENTABILIDADE E COMPRAS ............................................................... 9',
      'Conteúdo real do parágrafo.',
    ].join('\n');
    const out = cleanExtractedText(text);
    expect(out.includes('....')).toBe(false);
    expect(out).toContain('Conteúdo real');
  });

  it('removes standalone page-number lines', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = ['Texto antes', '12', 'Texto depois', '125'].join('\n');
    const out = cleanExtractedText(text);
    expect(out.split('\n').filter((l) => /^\d+$/.test(l.trim()))).toHaveLength(0);
    expect(out).toContain('Texto antes');
  });

  it('collapses runs of 3+ blank lines into a single blank', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = 'Bloco A\n\n\n\n\n\nBloco B';
    const out = cleanExtractedText(text);
    // After cleaning, between the two blocks there should be at most one blank line.
    expect(out).toMatch(/Bloco A\n\s*\n\s*Bloco B/);
    expect(out.match(/\n{3,}/)).toBeNull();
  });

  it('strips form-feed control characters', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = 'antes\fdepois';
    const out = cleanExtractedText(text);
    expect(out).not.toContain('\f');
    expect(out).toContain('antes');
    expect(out).toContain('depois');
  });

  it('removes per-page "página X de Y" footer variants (number varies, shape matches)', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text = [
      '© NEVI/CIEC BRevi2, apostila: "Compras Sustentáveis" – p. 2 de 125',
      'Conteúdo da página 2.',
      '© NEVI/CIEC BRevi2, apostila: "Compras Sustentáveis" – p. 3 de 125',
      'Conteúdo da página 3.',
      'Página 99 de 125',
      'Mais conteúdo.',
    ].join('\n');
    const out = cleanExtractedText(text);
    expect(out).not.toMatch(/p\.\s*\d+\s*de\s*\d+/i);
    expect(out).not.toMatch(/Página \d+ de \d+/i);
    expect(out).toContain('Conteúdo da página 2');
    expect(out).toContain('Mais conteúdo');
  });

  it('preserves normal multi-paragraph text untouched', async () => {
    const { cleanExtractedText } = await import('@/lib/ingest/clean');
    const text =
      'Primeiro parágrafo de teste com tamanho razoável.\n\n' +
      'Segundo parágrafo, também relevante para o conteúdo.\n\n' +
      'Terceiro parágrafo finalizando a amostra.';
    const out = cleanExtractedText(text);
    expect(out).toContain('Primeiro parágrafo');
    expect(out).toContain('Segundo parágrafo');
    expect(out).toContain('Terceiro parágrafo');
  });
});
