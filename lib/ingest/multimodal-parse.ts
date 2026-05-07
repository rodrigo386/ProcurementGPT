import { z } from 'zod';
import type { Block } from '@/lib/ingest/types';

export const MULTIMODAL_SYSTEM_PROMPT = `Você é um extrator estruturado de artigos acadêmicos sobre procurement.
Receba o PDF e retorne um array de blocos representando o conteúdo do
documento NA ORDEM EM QUE APARECE. Cada bloco é um de três tipos:

- text: parágrafo ou seção corrida. Junte parágrafos relacionados.
- table: qualquer tabela. Devolva o conteúdo como Markdown bem formado
  (linhas separadas por |, header divider com ---). Capture a legenda
  da tabela (ex: "Tabela 2: Matriz de Kraljic") em "caption".
- figure: diagrama, fluxograma, gráfico, ou qualquer figura visual NÃO
  textual. Em "description", produza 80–250 palavras descrevendo o que
  a figura mostra (eixos do gráfico, valores legíveis, nós do
  fluxograma e relações, elementos do diagrama). Em "caption", o
  rótulo (ex: "Figura 3: Fluxo de aprovação"). Em "figureKind", uma
  de: "flow" (fluxograma, processo), "chart" (gráfico com dados),
  "diagram" (diagrama conceitual sem dados).

Regras:
- NÃO invente conteúdo. Se uma figura é ilegível, descreva o que vê
  ("gráfico de barras com 5 categorias, valores não legíveis").
- NÃO inclua headers/footers/numeração de página repetidos.
- NÃO inclua TOC (sumário).
- Page é o número da página (1-indexed) onde o bloco começa.
- Output JSON estrito conforme schema.`;

export const MULTIMODAL_RETRY_SUFFIX = `\n\nSua resposta anterior não bateu com o schema. Retorne EXATAMENTE este shape JSON: { "blocks": [ ... ] } onde cada bloco tem "type" igual a "text" | "table" | "figure" e os campos obrigatórios descritos acima.`;

const TextBlock = z.object({
  type: z.literal('text'),
  page: z.number().int().min(1),
  content: z.string().min(1),
});
const TableBlock = z.object({
  type: z.literal('table'),
  page: z.number().int().min(1),
  markdown: z.string().min(1),
  caption: z.string().optional(),
});
const FigureBlock = z.object({
  type: z.literal('figure'),
  page: z.number().int().min(1),
  description: z.string().min(20),
  caption: z.string().optional(),
  figureKind: z.enum(['flow', 'chart', 'diagram']),
});

const BlockSchema = z.discriminatedUnion('type', [TextBlock, TableBlock, FigureBlock]);

export const MultimodalOutputSchema = z.object({
  blocks: z.array(BlockSchema).min(1),
});

/** JSON-Schema shape passed to Gemini's `responseSchema` config. */
export const MULTIMODAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'table', 'figure'] },
          page: { type: 'integer', minimum: 1 },
          content: { type: 'string' },
          markdown: { type: 'string' },
          description: { type: 'string' },
          caption: { type: 'string' },
          figureKind: { type: 'string', enum: ['flow', 'chart', 'diagram'] },
        },
        required: ['type', 'page'],
      },
    },
  },
  required: ['blocks'],
} as const;

export function validateBlocks(raw: unknown): Block[] {
  return MultimodalOutputSchema.parse(raw).blocks;
}
