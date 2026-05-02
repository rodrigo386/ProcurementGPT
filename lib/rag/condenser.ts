import { getGemini } from '@/lib/llm/gemini';
import { requireEnv } from '@/lib/env';
import type { ChatMessage } from './types';

const SYSTEM_PROMPT = `Reescreva a última pergunta do usuário como uma pergunta autônoma em português, incorporando o contexto necessário das mensagens anteriores. Responda APENAS com a pergunta reescrita, sem explicações, sem aspas, sem prefixos.`;

function lastUserContent(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1];
  return (last?.content ?? '').trim();
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function formatHistory(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i]!;
    const who = m.role === 'user' ? 'Usuário' : 'Assistente';
    lines.push(`${who}: ${m.content}`);
  }
  lines.push(`Última pergunta: ${messages[messages.length - 1]!.content}`);
  return lines.join('\n');
}

export async function condenseQuery(messages: ChatMessage[]): Promise<string> {
  if (messages.length <= 1) {
    return lastUserContent(messages);
  }
  try {
    const ai = getGemini();
    const model = requireEnv('GEMINI_MODEL');
    const res = await ai.models.generateContent({
      model,
      contents: `${SYSTEM_PROMPT}\n\n${formatHistory(messages)}`,
      config: { maxOutputTokens: 256 },
    });
    const text = (res.text ?? '').trim();
    if (!text) return lastUserContent(messages);
    return stripQuotes(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[rag/condenser] falling back to last user message:', message);
    return lastUserContent(messages);
  }
}
