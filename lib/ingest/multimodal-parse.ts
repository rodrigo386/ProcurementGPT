import { z } from 'zod';
import type { Block } from '@/lib/ingest/types';
import { getOpenAI, getOpenAIModel } from '@/lib/llm/openai';

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

// 20 MB base64-inlined cap. OpenAI accepts inline files up to ~32 MB via
// `responses.create({ input_file.file_data })`, but we go via the Files API
// above 20 MB to keep request bodies sane.
const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 32_768;

type InlineFilePart = { type: 'input_file'; filename: string; file_data: string };
type RemoteFilePart = { type: 'input_file'; file_id: string };
type PdfPart = InlineFilePart | RemoteFilePart;

async function callOpenAI(
  pdfPart: PdfPart,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const ai = getOpenAI();
  const model = getOpenAIModel();
  const res = await ai.responses.create(
    {
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: systemPrompt },
            pdfPart as never,
          ],
        },
      ],
      text: { format: { type: 'json_object' } },
      max_output_tokens: MAX_OUTPUT_TOKENS,
    },
    { signal },
  );
  return res.output_text ?? '';
}

function inlinePart(buf: Buffer, filename = 'doc.pdf'): InlineFilePart {
  return {
    type: 'input_file',
    filename,
    file_data: `data:application/pdf;base64,${buf.toString('base64')}`,
  };
}

async function tryWithRetry(
  initialPart: PdfPart,
  signal: AbortSignal,
): Promise<Block[]> {
  let raw = await callOpenAI(initialPart, MULTIMODAL_SYSTEM_PROMPT, signal);
  try {
    return validateBlocks(JSON.parse(raw));
  } catch (firstErr) {
    // Only retry on validation/JSON failures, not on network errors.
    if (!(firstErr instanceof z.ZodError) && !(firstErr instanceof SyntaxError)) {
      throw firstErr;
    }
    raw = await callOpenAI(
      initialPart,
      MULTIMODAL_SYSTEM_PROMPT + MULTIMODAL_RETRY_SUFFIX,
      signal,
    );
    return validateBlocks(JSON.parse(raw));
  }
}

export async function parsePdfMultimodal(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  if (buf.length > INLINE_LIMIT_BYTES) {
    return parsePdfMultimodalViaFiles(buf);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const blocks = await tryWithRetry(inlinePart(buf), controller.signal);
    return { blocks };
  } finally {
    clearTimeout(timer);
  }
}

async function parsePdfMultimodalViaFiles(
  buf: Buffer,
): Promise<{ blocks: Block[]; pageCount?: number }> {
  const ai = getOpenAI();
  const uploaded = await ai.files.create({
    file: new File([buf as unknown as ArrayBuffer], 'doc.pdf', {
      type: 'application/pdf',
    }),
    purpose: 'user_data',
  });
  const fileId = uploaded.id;
  if (!fileId) {
    throw new Error('OpenAI files.create returned no id');
  }
  const part: RemoteFilePart = { type: 'input_file', file_id: fileId };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const blocks = await tryWithRetry(part, controller.signal);
    return { blocks };
  } finally {
    clearTimeout(timer);
  }
}
