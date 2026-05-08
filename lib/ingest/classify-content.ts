import { z } from 'zod';
import { getOpenAI, getOpenAIModel } from '@/lib/llm/openai';
import { TAXONOMY, THEME_DESCRIPTIONS, isValidTheme, type Theme } from '@/lib/ingest/taxonomy';

const TIMEOUT_MS = 15_000;
const MAX_INPUT_CHARS = 6000;

const ClassifyResultSchema = z.object({
  title: z.string(),
  theme: z.string(),
  summary: z.string().optional(),
});

export type ClassifyResult = {
  title: string;
  theme: Theme;
  summary: string;
};

function filenameStem(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  return withoutExt.replace(/[_\-]+/g, ' ').trim();
}

function fallback(filename: string): ClassifyResult {
  const stem = filenameStem(filename);
  return { title: stem || 'Sem título', theme: 'Outros' as Theme, summary: '' };
}

function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function buildSystemPrompt(): string {
  const descriptions = TAXONOMY.map((t) => `  - ${t}: ${THEME_DESCRIPTIONS[t]}`).join('\n');
  return `Você é um especialista em procurement (compras corporativas) classificando artigos acadêmicos. Receba um trecho de texto extraído do artigo e devolva JSON com EXATAMENTE 3 campos:

- title: string em português (ou idioma original se não for PT) com 60-100 caracteres que reflete o ASSUNTO CENTRAL do artigo. NÃO copie headers, números de página, nomes de revistas ou afiliações institucionais. Pense: "qual é o tema único deste artigo?" e escreva como um título de capítulo.

- theme: um de exatamente: ${TAXONOMY.join(' | ')}.
  Use as descrições abaixo pra guiar:
${descriptions}

- summary: string de até 200 caracteres com uma única frase resumindo a contribuição central do artigo. Sem chavões, sem "este artigo discute".

Não inclua explicações fora do JSON. Responda EXCLUSIVAMENTE com o objeto.`;
}

export async function classifyContent(
  text: string,
  filename: string,
): Promise<ClassifyResult> {
  console.info(`[ingest/classify] sending text bytes=${text.length} filename=${filename}`);

  const truncated = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const ai = getOpenAI();
    const res = await ai.chat.completions.create(
      {
        model: getOpenAIModel(),
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: truncated },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 400,
      },
      { signal: controller.signal },
    );

    const raw = res.choices[0]?.message?.content ?? '';
    const parsed = ClassifyResultSchema.parse(JSON.parse(raw));

    if (!isValidTheme(parsed.theme)) {
      console.warn(`[ingest/classify] fallback for ${filename}: invalid theme "${parsed.theme}"`);
      return fallback(filename);
    }

    const title = stripWrappingQuotes(parsed.title);
    if (title.length < 10) {
      console.warn(`[ingest/classify] fallback for ${filename}: title too short ("${title}")`);
      return fallback(filename);
    }

    const summary = (parsed.summary ?? '').trim().slice(0, 220);
    const result: ClassifyResult = { title, theme: parsed.theme as Theme, summary };
    console.info(`[ingest/classify] result title="${title}" theme=${result.theme}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ingest/classify] fallback for ${filename}: ${message}`);
    return fallback(filename);
  } finally {
    clearTimeout(timer);
  }
}
