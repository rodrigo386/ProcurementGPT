import { GoogleGenAI } from '@google/genai';
import { requireEnv } from '@/lib/env';

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
  const res = await ai.models.generateContent({
    model,
    contents: 'ping',
    config: { maxOutputTokens: 8 },
  });
  return res.text ?? '';
}
