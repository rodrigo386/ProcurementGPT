import { requireEnv } from '@/lib/env';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const TIMEOUT_MS = 30_000;

export type VoyageInputType = 'query' | 'document';

export async function embed(
  texts: string[],
  inputType?: VoyageInputType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = requireEnv('VOYAGE_API_KEY');
  const model = requireEnv('VOYAGE_MODEL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body: Record<string, unknown> = { model, input: texts };
  if (inputType) body.input_type = inputType;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
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
