import { describe, expect, it } from 'vitest';

describe('lib/ingest/metadata', () => {
  it('extracts title from the first non-empty heading-shaped line', async () => {
    const { extractMetadata } = await import('@/lib/ingest/metadata');
    const text =
      'Matriz de Kraljic na Prática Industrial\n\n' +
      'Este artigo discute a aplicação da matriz de Kraljic em ambientes industriais brasileiros. ' +
      'A análise considera fatores de risco e impacto financeiro nos quadrantes propostos.';
    const meta = extractMetadata(text, 'kraljic.pdf');
    expect(meta.title).toBe('Matriz de Kraljic na Prática Industrial');
  });

  it('extracts author from "Author:" / "Autor:" patterns near the top', async () => {
    const { extractMetadata } = await import('@/lib/ingest/metadata');
    const text =
      'Some Title\n\nAuthor: João Silva\n\nIntrodução: este artigo apresenta...';
    const meta = extractMetadata(text, 'paper.pdf');
    expect(meta.author).toBe('João Silva');
  });

  it('detects PT vs EN by stopword frequency', async () => {
    const { extractMetadata } = await import('@/lib/ingest/metadata');
    const pt =
      'O artigo discute a matriz de Kraljic e o impacto da cadeia de suprimentos com foco em compras estratégicas para empresas industriais brasileiras.';
    const en =
      'The paper discusses the Kraljic matrix and the impact of the supply chain with focus on strategic procurement for industrial companies in modern markets.';
    expect(extractMetadata(pt, 'a.pdf').language).toBe('pt');
    expect(extractMetadata(en, 'a.pdf').language).toBe('en');
  });
});
