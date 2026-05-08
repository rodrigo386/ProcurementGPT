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
  // Lenient: gpt-4o-mini occasionally emits values outside the prompt's
  // enum (most commonly `'table'` for a figure that contains a table).
  // We accept any string here and coerce invalid values to `'diagram'`
  // in validateBlocks() rather than failing the whole batch.
  figureKind: z.string().optional(),
});

const VALID_FIGURE_KINDS = ['flow', 'chart', 'diagram'] as const;
type ValidFigureKind = (typeof VALID_FIGURE_KINDS)[number];
function coerceFigureKind(raw: string | undefined): ValidFigureKind {
  if (raw && (VALID_FIGURE_KINDS as readonly string[]).includes(raw)) {
    return raw as ValidFigureKind;
  }
  return 'diagram';
}

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
    const figureKind = coerceFigureKind(b.figureKind);
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

// Route anything ≥10 MB through Files API. Inline base64 inflates the body
// ~33% (12 MB PDF → ~16 MB string) plus JSON overhead, and we observed
// gpt-4o-mini taking >120s on visually-dense 12 MB ebooks delivered inline.
// Files API uploads once and references by ID, halving per-request weight.
const INLINE_LIMIT_BYTES = 10 * 1024 * 1024;
// 5 minutes. gpt-4o-mini can take 60–180s on large image-heavy PDFs (40+
// pages, lots of figures). Previous 120s aborted real successful runs in the
// middle. The pipeline is fire-and-forget on Railway so the wait does not
// block the admin UI.
const TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 32_768;

type InlineFilePart = { type: 'input_file'; filename: string; file_data: string };
type RemoteFilePart = { type: 'input_file'; file_id: string };
type PdfPart = InlineFilePart | RemoteFilePart;

// Parse the "Please try again in Xs" hint from a 429 RateLimitError. Falls
// back to 5s when the message shape changes.
function rateLimitWaitMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : '';
  const m = msg.match(/try again in ([0-9.]+)s/i);
  const secs = m ? Number(m[1]) : NaN;
  return Number.isFinite(secs) ? Math.ceil(secs * 1000) + 500 : 5_000;
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return e?.status === 429 || e?.code === 'rate_limit_exceeded';
}

async function rawCallOpenAI(
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

async function callOpenAI(
  pdfPart: PdfPart,
  systemPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  // Retry once on 429 (TPM rate limit). The 200k tok/min default tier is
  // easy to saturate when admin uploads several PDFs back-to-back; OpenAI
  // tells us when to retry, so we honor it. One retry is enough — if a
  // second 429 lands, the caller falls back to text-only.
  try {
    return await rawCallOpenAI(pdfPart, systemPrompt, signal);
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    const waitMs = rateLimitWaitMs(err);
    console.warn(
      `[ingest/multimodal] 429 rate limit; waiting ${waitMs}ms before single retry`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    if (signal.aborted) throw err;
    return await rawCallOpenAI(pdfPart, systemPrompt, signal);
  }
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
