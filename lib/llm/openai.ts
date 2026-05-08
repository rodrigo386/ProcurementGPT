import OpenAI from 'openai';
import { requireEnv } from '@/lib/env';

const TIMEOUT_MS = 30_000;

let instance: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (instance) return instance;
  const apiKey = requireEnv('OPENAI_API_KEY');
  instance = new OpenAI({ apiKey });
  return instance;
}

export function getOpenAIModel(): string {
  return process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
}

/**
 * Wrap a single OpenAI call with one retry on 429 (TPM rate limit), honoring
 * the SDK's "try again in Xs" hint. Other errors (network, 5xx, validation)
 * are re-thrown immediately so the caller's fallback path can take over.
 *
 * Used by every OpenAI call site that runs during ingest, since admin batch
 * uploads can saturate the default-tier 200 k tok/min limit. One retry is
 * usually enough; a second 429 means the bucket is fully drained and the
 * caller should fall back rather than stack more waits.
 */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isRateLimit(err)) throw err;
    const waitMs = rateLimitWaitMs(err);
    console.warn(`[${label}] 429 rate limit; waiting ${waitMs}ms before single retry`);
    await new Promise((r) => setTimeout(r, waitMs));
    if (signal.aborted) throw err;
    return await call();
  }
}

function rateLimitWaitMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : '';
  const m = msg.match(/try again in ([0-9.]+)s/i);
  const secs = m ? Number(m[1]) : NaN;
  return Number.isFinite(secs) ? Math.ceil(secs * 1000) + 500 : 5_000;
}

function isRateLimit(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return e?.status === 429 || e?.code === 'rate_limit_exceeded';
}

export async function pingOpenAI(): Promise<string> {
  const ai = getOpenAI();
  const model = getOpenAIModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await ai.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_completion_tokens: 8,
      },
      { signal: controller.signal },
    );
    return res.choices[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}
