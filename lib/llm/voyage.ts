import { requireEnv } from '@/lib/env';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = requireEnv('VOYAGE_API_KEY');
  const model = requireEnv('VOYAGE_MODEL');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Voyage embed failed (${res.status}): ${detail}`);
  }

  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data.map((d) => d.embedding);
}
