import { z } from 'zod';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import type { Classification, RetrievedChunk } from './types';
import type { Trace } from '@/lib/observability/types';

const SNIPPET_MAX = 240;
const ITEM_MAX_CHARS = 120;
const TIMEOUT_MS = 3_000;

const FollowupsSchema = z.object({
  followups: z.array(z.string().min(3).max(ITEM_MAX_CHARS)).min(1).max(3),
});

const SYSTEM_DEEPEN_PT = `Voce e um assistente que sugere 3 perguntas curtas de follow-up para um usuario que acabou de receber uma resposta sobre teoria de procurement. As perguntas devem aprofundar o tema, ser respondiveis a partir do material abaixo, e ter no maximo 90 caracteres cada. Nao inclua a pergunta original. Nao use IDs, numeros entre colchetes, nem cite fontes. Retorne JSON com a forma { "followups": [string, string, string] }.`;

const SYSTEM_REDIRECT_PT = `Voce e um assistente que ajuda um usuario cuja pergunta nao foi respondida porque a base de conhecimento nao tinha material sobre o topico. Sugira 3 reformulacoes ou topicos proximos de procurement (matriz de Kraljic, TCO, modelos de Cox / Cousins / Monczka, sourcing estrategico, gestao de fornecedores, Porter, Dyer, etc.) que possam estar na base. Nao prometa que a base cobre o tema; apenas sugira reformulacoes. No maximo 90 caracteres cada. Retorne JSON com a forma { "followups": [string, string, string] }.`;

const SYSTEM_DEEPEN_EN = `You are an assistant suggesting 3 short follow-up questions for a user who just received an answer about procurement theory. The questions should deepen the topic, be answerable from the material below, and be at most 90 characters each. Do not include the original question. Do not use IDs, bracketed numbers, or source citations. Return JSON shaped { "followups": [string, string, string] }.`;

const SYSTEM_REDIRECT_EN = `You are an assistant helping a user whose question was not answered because the knowledge base had no material on the topic. Suggest 3 reformulations or adjacent procurement topics (Kraljic matrix, TCO, Cox / Cousins / Monczka, strategic sourcing, supplier management, Porter, Dyer, etc.) that may exist in the base. Do not promise that the base covers the topic; only suggest reformulations. At most 90 characters each. Return JSON shaped { "followups": [string, string, string] }.`;

const LABELS = {
  pt: {
    origQ: '## Pergunta original',
    given: '## Resposta dada',
    material: '## Material disponivel',
    refusalQ: '## Pergunta original (nao respondida)',
  },
  en: {
    origQ: '## Original question',
    given: '## Answer given',
    material: '## Available material',
    refusalQ: '## Original question (unanswered)',
  },
} as const;

export type SuggestFollowupsInput = {
  query: string;
  answer: string;
  chunks: RetrievedChunk[];
  classification: Classification;
  parentTrace?: Trace;
};

function postProcess(items: string[], query: string): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const queryNorm = norm(query);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = norm(trimmed);
    if (key === queryNorm) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  try {
    const { query, answer, chunks, classification } = input;
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');

    const lang = classification.language;
    const mode: 'deepen' | 'redirect' = chunks.length > 0 ? 'deepen' : 'redirect';
    const system =
      mode === 'deepen'
        ? lang === 'en'
          ? SYSTEM_DEEPEN_EN
          : SYSTEM_DEEPEN_PT
        : lang === 'en'
          ? SYSTEM_REDIRECT_EN
          : SYSTEM_REDIRECT_PT;
    const L = LABELS[lang];

    let userBlock: string;
    if (mode === 'deepen') {
      const material = chunks
        .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
        .join('\n');
      userBlock = [L.origQ, query, '', L.given, answer, '', L.material, material].join('\n');
    } else {
      userBlock = [L.refusalQ, query].join('\n');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: `${system}\n\n${userBlock}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              followups: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 3,
              },
            },
            required: ['followups'],
          },
          maxOutputTokens: 512,
          abortSignal: controller.signal,
        },
      });
      const text = res.text ?? '';
      const parsed = FollowupsSchema.parse(JSON.parse(text));
      return postProcess(parsed.followups, query);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[rag/followups] returning [] due to error:', message);
    return [];
  }
}
