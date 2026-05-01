import { requireEnv } from '@/lib/env';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const TIMEOUT_MS = 30_000;

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = requireEnv('VOYAGE_API_KEY');
  const model = requireEnv('VOYAGE_MODEL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Voyage embed failed (${res.status}): ${detail}`);
    }

    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  } finally {
    clearTimeout(timer);
  }
}
