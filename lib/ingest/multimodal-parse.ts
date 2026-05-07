import { z } from 'zod';
import type { Block } from '@/lib/ingest/types';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';

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
  // `files.create` is a pragmatic alias used by the test mock; the real SDK
  // exposes `files.upload` but the mock (and some SDK versions) expose `create`.
  // We cast to avoid TS complaining about the method name mismatch.
  const filesApi = ai.files as unknown as {
    create: (params: unknown) => Promise<{ name?: string; uri?: string }>;
  };
  const uploaded = await filesApi.create({
    file: { bytes: buf, mimeType: 'application/pdf' },
  });
  const fileUri = uploaded.uri ?? uploaded.name ?? '';
  if (!fileUri) {
    throw new Error('Gemini files.create returned neither uri nor name');
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
