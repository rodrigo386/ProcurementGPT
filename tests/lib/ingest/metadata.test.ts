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

  it('rejects a CPF-shaped first line and falls through to the next candidate', async () => {
    const { extractMetadata } = await import('@/lib/ingest/metadata');
    const text =
      '036.310.189-67 Celso Rudey\n\n' +
      'Apostila Compras Sustentáveis\n\n' +
      'Este documento descreve as práticas de compras sustentáveis no setor industrial brasileiro.';
    const meta = extractMetadata(text, 'apostila.pdf');
    expect(meta.title).toBe('Apostila Compras Sustentáveis');
  });

  it('rejects mostly-digits / non-alpha first lines and falls back to filename when no candidate qualifies', async () => {
    const { extractMetadata } = await import('@/lib/ingest/metadata');
    const text =
      '12/05/2024\n\n' +
      '00.000.000/0001-00\n\n' +
      '125\n\n' +
      'a.\n\n' +
      'b.\n\n' +
      'Conteúdo do corpo do documento começa aqui de fato.';
    const meta = extractMetadata(text, 'meu_doc_relevante.pdf');
    expect(meta.title).toBe('meu doc relevante');
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
