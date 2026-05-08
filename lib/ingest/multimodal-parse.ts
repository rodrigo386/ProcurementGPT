import { z } from 'zod';
import type { Block } from '@/lib/ingest/types';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';

export const MULTIMODAL_SYSTEM_PROMPT = `Você é um extrator LITERAL de PDFs sobre procurement. Sua tarefa é
TRANSCREVER o conteúdo do documento INTEGRALMENTE — NÃO RESUMA, NÃO
PARAFRASEIE, NÃO CONDENSE, NÃO PULE PARÁGRAFOS. A saída tem que
preservar o volume e o vocabulário do PDF original.

Retorne um array de blocos representando o documento NA ORDEM em que
aparecem. Cada bloco é um de três tipos:

- text: UM parágrafo de prosa corrida do PDF. Cada parágrafo do
  documento vira UM bloco text separado — NÃO consolide múltiplos
  parágrafos no mesmo bloco. Bullets e itens de lista contam como
  parágrafos curtos (um bloco por item). Transcreva o texto LITERAL,
  palavra por palavra, sem reescrever.
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

Regras de completude (CRÍTICAS):
- A saída TEM que refletir o volume real do PDF. Documento de 40
  páginas produz dezenas de blocos, não 2 ou 3. Documento de 5 páginas
  produz vários blocos por página. PDF longo → resposta longa.
- NÃO sintetize, NÃO comprima, NÃO "junte ideias parecidas". Cada
  parágrafo do PDF tem que sair como bloco separado, transcrito
  integralmente.
- "page" é o número REAL da página (1-indexed) onde o bloco começa.
  É esperado e correto que MUITOS blocos compartilhem a mesma página.
  NÃO marque tudo como "page 1" ou "page 2" para economizar saída.

Regras de filtragem:
- NÃO invente conteúdo. Se uma figura é ilegível, descreva o que vê
  ("gráfico de barras com 5 categorias, valores não legíveis").
- NÃO inclua headers/footers/numeração de página repetidos.
- NÃO inclua TOC (sumário).
- Output JSON estrito conforme schema.`;

export const MULTIMODAL_RETRY_SUFFIX = `\n\nSua resposta anterior não bateu com o schema. Retorne EXATAMENTE este shape JSON: { "blocks": [ ... ] } onde cada bloco tem "type" igual a "text" | "table" | "figure" e os campos obrigatórios descritos acima.`;

// Lenient input shapes — Gemini's `responseSchema` JSON-Schema subset only
// supports a flat `required` array, so we cannot make per-type fields strictly
// required at the API layer. Accept loose shapes here and filter / repair after
// parsing. See validateBlocks() for the type-narrowing pipeline.
const RawTextBlock = z.object({
  type: z.literal('text'),
  page: z.number().int().min(1),
  content: z.string().optional(),
});
const RawTableBlock = z.object({
  type: z.literal('table'),
  page: z.number().int().min(1),
  markdown: z.string().optional(),
  caption: z.string().optional(),
});
const RawFigureBlock = z.object({
  type: z.literal('figure'),
  page: z.number().int().min(1),
  description: z.string().optional(),
  caption: z.string().optional(),
  figureKind: z.enum(['flow', 'chart', 'diagram']).optional(),
});

const RawBlockSchema = z.discriminatedUnion('type', [
  RawTextBlock,
  RawTableBlock,
  RawFigureBlock,
]);

export const MultimodalOutputSchema = z.object({
  blocks: z.array(RawBlockSchema).min(1),
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

/**
 * Validate the raw Gemini response and narrow each block to a usable Block.
 *
 * Gemini may legitimately omit per-type fields (e.g. a 'figure' with no
 * description, or a 'table' that came back with the cells in `content`
 * instead of `markdown`). Rather than throw — which would force a retry
 * and ultimately the text-only fallback — we repair what we can and drop
 * blocks that have no usable content.
 *
 * Throws when the result would be empty (caller treats as failure and
 * falls back to text-only).
 */
export function validateBlocks(raw: unknown): Block[] {
  const parsed = MultimodalOutputSchema.parse(raw);
  const out: Block[] = [];
  for (const b of parsed.blocks) {
    if (b.type === 'text') {
      const content = b.content?.trim();
      if (content) out.push({ type: 'text', page: b.page, content });
      continue;
    }
    if (b.type === 'table') {
      const markdown = b.markdown?.trim();
      if (markdown) {
        out.push({
          type: 'table',
          page: b.page,
          markdown,
          ...(b.caption ? { caption: b.caption } : {}),
        });
      }
      continue;
    }
    // figure
    const description = b.description?.trim();
    const caption = b.caption?.trim();
    const figureKind = b.figureKind ?? 'diagram';
    // Drop figures with no description AND no caption — nothing to embed.
    if (!description && !caption) continue;
    out.push({
      type: 'figure',
      page: b.page,
      description: description || (caption as string),
      ...(caption ? { caption } : {}),
      figureKind,
    });
  }
  if (out.length === 0) {
    throw new Error('multimodal parse produced no usable blocks after repair');
  }
  return out;
}

const INLINE_LIMIT_BYTES = 20 * 1024 * 1024; // 20 MB
const TIMEOUT_MS = 120_000;

type InlinePart = { inlineData: { mimeType: string; data: string } };
type FilePart = { fileData: { fileUri: string; mimeType: string } };
type PdfPart = InlinePart | FilePart;

async function callGemini(
  pdfPart: PdfPart,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');
  const res = await ai.models.generateContent({
    model,
    contents: [
      pdfPart as never,
      { text: systemPrompt } as never,
    ] as never,
    config: {
      responseMimeType: 'application/json',
      responseSchema: MULTIMODAL_RESPONSE_SCHEMA as never,
      maxOutputTokens: 32_768,
      abortSignal: signal,
    },
  });
  return res.text ?? '';
}

export async function parsePdfMultimodal(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  if (buf.length > INLINE_LIMIT_BYTES) {
    return parsePdfMultimodalViaFiles(buf);
  }

  const part: InlinePart = {
    inlineData: {
      mimeType: 'application/pdf',
      data: buf.toString('base64'),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let raw = '';
    try {
      raw = await callGemini(part, MULTIMODAL_SYSTEM_PROMPT, controller.signal);
      const blocks = validateBlocks(JSON.parse(raw));
      return { blocks };
    } catch (firstErr) {
      // Only retry on validation/JSON failures, not on network errors.
      if (!(firstErr instanceof z.ZodError) && !(firstErr instanceof SyntaxError)) {
        throw firstErr;
      }
      raw = await callGemini(
        part,
        MULTIMODAL_SYSTEM_PROMPT + MULTIMODAL_RETRY_SUFFIX,
        controller.signal,
      );
      const blocks = validateBlocks(JSON.parse(raw));
      return { blocks };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function parsePdfMultimodalViaFiles(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  const ai = getGemini();
  const uploaded = await ai.files.upload({
    file: new Blob([buf as unknown as ArrayBuffer], { type: 'application/pdf' }),
    config: { mimeType: 'application/pdf' },
  });
  const fileUri = uploaded.name;
  if (!fileUri) {
    throw new Error('Gemini files.upload returned no name');
  }
  const part: FilePart = {
    fileData: {
      fileUri,
      mimeType: 'application/pdf',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    try {
      const raw = await callGemini(part, MULTIMODAL_SYSTEM_PROMPT, controller.signal);
      return { blocks: validateBlocks(JSON.parse(raw)) };
    } catch (firstErr) {
      if (!(firstErr instanceof z.ZodError) && !(firstErr instanceof SyntaxError)) {
        throw firstErr;
      }
      const raw = await callGemini(
        part,
        MULTIMODAL_SYSTEM_PROMPT + MULTIMODAL_RETRY_SUFFIX,
        controller.signal,
      );
      return { blocks: validateBlocks(JSON.parse(raw)) };
    }
  } finally {
    clearTimeout(timer);
  }
}
