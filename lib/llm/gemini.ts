import { GoogleGenAI } from '@google/genai';
import { requireEnv } from '@/lib/env';

const TIMEOUT_MS = 30_000;

let instance: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI {
  if (instance) return instance;
  const apiKey = requireEnv('GOOGLE_API_KEY');
  instance = new GoogleGenAI({ apiKey });
  return instance;
}

export async function pingGemini(): Promise<string> {
  const ai = getGemini();
  const model = requireEnv('GEMINI_MODEL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'ping',
      config: { maxOutputTokens: 8, abortSignal: controller.signal },
    });
    return res.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}
