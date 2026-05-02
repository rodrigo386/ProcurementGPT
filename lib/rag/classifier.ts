import { z } from 'zod';
import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import { SAFE_DEFAULT_CLASSIFICATION, type Classification } from './types';

const SYSTEM_PROMPT = `Você classifica perguntas de usuários sobre teorias de procurement (compras corporativas).
Responda SEMPRE com JSON estrito conforme o schema abaixo. Não adicione texto fora do JSON.

Campos:
- theory: string com o nome curto da teoria/framework principal mencionada (ex: "kraljic", "porter", "monczka", "tco", "srm"). null se nenhuma teoria específica for citada ou inferível.
- intent: um de "definition" | "application" | "comparison" | "recommendation" | "smalltalk".
  - definition: pede o que é, conceito, definição
  - application: pede como aplicar, exemplo prático, caso
  - comparison: compara duas ou mais teorias/frameworks
  - recommendation: pede sugestão de abordagem/teoria/leitura
  - smalltalk: saudação, agradecimento, pergunta sobre o próprio bot, sem conteúdo de procurement
- language: "pt" se a pergunta está em português, "en" se em inglês. Default "pt".
- needsRetrieval: false APENAS se intent = "smalltalk". Senão true.`;

const ClassificationSchema = z.object({
  theory: z.string().nullable(),
  intent: z.enum(['definition', 'application', 'comparison', 'recommendation', 'smalltalk']),
  language: z.enum(['pt', 'en']),
  needsRetrieval: z.boolean(),
});

export async function classify(query: string): Promise<Classification> {
  try {
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');
    const res = await ai.models.generateContent({
      model,
      contents: `${SYSTEM_PROMPT}\n\nPergunta:\n${query}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            theory: { type: 'string', nullable: true },
            intent: {
              type: 'string',
              enum: ['definition', 'application', 'comparison', 'recommendation', 'smalltalk'],
            },
            language: { type: 'string', enum: ['pt', 'en'] },
            needsRetrieval: { type: 'boolean' },
          },
          required: ['theory', 'intent', 'language', 'needsRetrieval'],
        },
        maxOutputTokens: 256,
      },
    });
    const text = res.text ?? '';
    const parsed = ClassificationSchema.parse(JSON.parse(text));
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[rag/classifier] falling back to safe default:', message);
    return { ...SAFE_DEFAULT_CLASSIFICATION };
  }
}
