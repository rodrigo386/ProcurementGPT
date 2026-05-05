import { z } from 'zod';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import type { Classification, RetrievedChunk } from './types';
import type { Trace } from '@/lib/observability/types';

const SNIPPET_MAX = 240;
const ITEM_MAX_CHARS = 120;

const FollowupsSchema = z.object({
  followups: z.array(z.string().min(3).max(ITEM_MAX_CHARS)).min(1).max(3),
});

const SYSTEM_DEEPEN_PT = `Voce e um assistente que sugere 3 perguntas curtas de follow-up para um usuario que acabou de receber uma resposta sobre teoria de procurement. As perguntas devem aprofundar o tema, ser respondiveis a partir do material abaixo, e ter no maximo 90 caracteres cada. Nao inclua a pergunta original. Nao use IDs, numeros entre colchetes, nem cite fontes. Retorne JSON com a forma { "followups": [string, string, string] }.`;

export type SuggestFollowupsInput = {
  query: string;
  answer: string;
  chunks: RetrievedChunk[];
  classification: Classification;
  parentTrace?: Trace;
};

export async function suggestFollowups(input: SuggestFollowupsInput): Promise<string[]> {
  const { query, answer, chunks } = input;
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');

  const system = SYSTEM_DEEPEN_PT;
  const material = chunks
    .map((c) => `- ${c.articleTitle}: ${c.content.slice(0, SNIPPET_MAX)}`)
    .join('\n');
  const userBlock = [
    '## Pergunta original',
    query,
    '',
    '## Resposta dada',
    answer,
    '',
    '## Material disponivel',
    material,
  ].join('\n');

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
    },
  });
  const text = res.text ?? '';
  const parsed = FollowupsSchema.parse(JSON.parse(text));
  return parsed.followups;
}
